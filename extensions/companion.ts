import { execFile } from "node:child_process";
import { X_OK } from "node:constants";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CreateAgentSessionOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export const COMPANION_MESSAGE_TYPE = "companion";
export const COMPANION_MARKER = "PI_COMPANION_SESSION";
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const COMPANION_PANE_TOOLS = [...READ_ONLY_TOOLS, "dispatch_directive", "host_snapshot"] as const;
export const FALLBACK_MODEL = "cliproxyapi/gemini-3.8-flash-high:medium";
export const MAX_DIRECTIVE_LENGTH = 1000;
const COMPANION_PANE_NAME = "companion";
const DISPATCH_PARAMETERS = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "One-line directive for the caller pane." },
    reason: { type: "string", description: "Why the caller should receive this directive." },
  },
  required: ["prompt", "reason"],
  additionalProperties: false,
} as TSchema;
const HOST_SNAPSHOT_PARAMETERS = { type: "object", properties: {}, additionalProperties: false } as TSchema;

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
const DEFAULT_EFFORT: Effort = "medium";

export const USAGE = [
  "companion usage",
  "/companion <question>                            ask the read-only tutor about this project",
  "/companion open                                  open or reuse the persistent tutor pane",
  "/companion new                                   open a temporary tutor with a fresh transcript",
  "/companion close                                 close the active tutor pane without deleting history",
  "/companion snapshot                              show a bounded snapshot of this host session",
  "/companion status                                show model, effort, transcript size and project key",
  "/companion model <alias|provider/model[:effort]> set this project's model",
  "/companion send <prompt>                         ask the companion to dispatch a directive to its caller",
  "/companion reset                                 archive the transcript and start a fresh one",
  "/companion auto on|off                          enable or disable automatic pane opening",
].join("\n");

export type ModelSource = "meta" | "setting" | "role" | "fallback";

export type ResolvedModel =
  | { ok: true; provider: string; model: string; effort: Effort; source: ModelSource; alias?: string }
  | { ok: false; source: ModelSource; error: string };

export type ParsedCommand =
  | { kind: "usage" }
  | { kind: "open" }
  | { kind: "new" }
  | { kind: "close" }
  | { kind: "snapshot" }
  | { kind: "status" }
  | { kind: "reset" }
  | { kind: "auto"; value: boolean }
  | { kind: "model"; value: string }
  | { kind: "send"; prompt: string }
  | { kind: "question"; question: string };

export type CompanionMeta = { model?: string; cwd: string; created: string };

// NOTE: a lone token is treated as a mistyped subcommand; questions have spaces.
export function parseCompanionArgs(args: string): ParsedCommand {
  const text = args.trim();
  if (!text) return { kind: "usage" };
  if (text === "open") return { kind: "open" };
  if (text === "new") return { kind: "new" };
  if (text === "close") return { kind: "close" };
  if (text === "snapshot") return { kind: "snapshot" };
  if (text === "status") return { kind: "status" };
  if (text === "reset") return { kind: "reset" };
  if (text === "auto on") return { kind: "auto", value: true };
  if (text === "auto off") return { kind: "auto", value: false };
  if (text === "auto") return { kind: "usage" };
  if (text === "model") return { kind: "usage" };
  if (text === "send") return { kind: "usage" };
  if (text.startsWith("send ")) {
    const prompt = text.slice("send ".length).trim();
    return prompt ? { kind: "send", prompt } : { kind: "usage" };
  }
  if (text.startsWith("model ")) {
    const value = text.slice("model ".length).trim();
    return value ? { kind: "model", value } : { kind: "usage" };
  }
  if (!/\s/.test(text)) return { kind: "usage" };
  return { kind: "question", question: text };
}

function parseModelSpec(spec: string): { name: string; effort: Effort } {
  const colon = spec.lastIndexOf(":");
  if (colon > 0) {
    const suffix = spec.slice(colon + 1);
    if ((EFFORTS as readonly string[]).includes(suffix)) {
      return { name: spec.slice(0, colon), effort: suffix as Effort };
    }
  }
  return { name: spec, effort: DEFAULT_EFFORT };
}

function splitProviderModel(spec: string): { provider: string; model: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

export function resolveModelRef(
  input: string,
  aliases: Record<string, string>,
): { ok: true; provider: string; model: string; effort: Effort; alias?: string } | { ok: false; error: string } {
  const parsed = parseModelSpec(input.trim());
  if (parsed.name.includes("/")) {
    const parts = splitProviderModel(parsed.name);
    if (!parts) return { ok: false, error: `Invalid model reference: ${input}` };
    return { ok: true, ...parts, effort: parsed.effort };
  }

  const aliasTarget = aliases[parsed.name];
  if (!aliasTarget) return { ok: false, error: `Unknown model alias: ${parsed.name}` };

  const target = parseModelSpec(aliasTarget.trim());
  const parts = splitProviderModel(target.name);
  if (!parts) return { ok: false, error: `Alias ${parsed.name} does not resolve to provider/model: ${aliasTarget}` };
  return { ok: true, ...parts, effort: target.effort, alias: parsed.name };
}

export function resolveCompanionModel(input: {
  metaModel?: string;
  extensionModel?: string;
  roleModel?: string;
  aliases: Record<string, string>;
}): ResolvedModel {
  const candidates: Array<[ModelSource, string | undefined]> = [
    ["meta", input.metaModel],
    ["setting", input.extensionModel],
    ["role", input.roleModel],
    ["fallback", FALLBACK_MODEL],
  ];

  for (const [source, value] of candidates) {
    const spec = value?.trim();
    if (!spec) continue;
    const resolved = resolveModelRef(spec, input.aliases);
    // The shipped role points at an alias the host may not define; that default is not a user choice.
    if (!resolved.ok && source === "role") continue;
    return resolved.ok ? { ...resolved, source } : { ok: false, source, error: resolved.error };
  }

  return { ok: false, source: "fallback", error: "No companion model configured" };
}

export function mergeAliasMaps(
  ...maps: Array<Record<string, string> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const map of maps) {
    for (const [name, target] of Object.entries(map ?? {})) {
      if (!(name in merged) && typeof target === "string") merged[name] = target;
    }
  }
  return merged;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const map: Record<string, string> = {};
  for (const [key, target] of Object.entries(value)) {
    if (typeof target === "string") map[key] = target;
  }
  return map;
}

export function readAliasMap(agentDir: string): Record<string, string> {
  const roles = stringMap(readJsonObject(join(agentDir, "pi-ext-roles", "settings.json"))?.modelAliases);
  const workflows = stringMap(
    readJsonObject(join(agentDir, "pi-extensible-workflows", "settings.json"))?.modelAliases,
  );
  return mergeAliasMaps(roles, workflows);
}

function companionSettingsPath(agentDir: string): string {
  return join(agentDir, "companion", "settings.json");
}

// Optional global defaults: <agentDir>/companion/settings.json {"model": "...", "autoOpen": false}
export function readExtensionModel(agentDir: string): string | undefined {
  const model = readJsonObject(companionSettingsPath(agentDir))?.model;
  return typeof model === "string" && model.trim() ? model : undefined;
}

export function readAutoOpenSetting(agentDir: string): boolean {
  return readJsonObject(companionSettingsPath(agentDir))?.autoOpen === true;
}

export function parseRole(markdown: string): { model?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return { body: markdown.trim() };
  const modelLine = /^model:\s*(.+?)\s*$/m.exec(match[1]);
  const model = modelLine?.[1].replace(/^["']|["']$/g, "");
  return { model, body: markdown.slice(match[0].length).trim() };
}

export function projectKey(root: string): string {
  return createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
}

export function resolveProjectRoot(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

export type CompanionPaths = {
  key: string;
  dir: string;
  sessionPath: string;
  metaPath: string;
  launcherPath: string;
  openRecordPath: string;
  openLockPath: string;
  snapshotPath: string;
};

export function companionPaths(agentDir: string, root: string): CompanionPaths {
  const key = projectKey(root);
  const dir = join(agentDir, "companion", key);
  return {
    key,
    dir,
    sessionPath: join(dir, "session.jsonl"),
    metaPath: join(dir, "meta.json"),
    launcherPath: join(dir, "launcher.sh"),
    openRecordPath: join(dir, "open.json"),
    openLockPath: join(dir, "open.lock"),
    snapshotPath: join(dir, "host-snapshot.json"),
  };
}

export type OpenRecord = {
  sessionId: string;
  paneId: string;
  timestamp: string;
  sessionPath?: string;
  kind?: "canonical" | "temporary";
  state?: "open" | "closed";
  closedAt?: string;
};

export function readOpenRecord(recordPath: string): OpenRecord | undefined {
  const raw = readJsonObject(recordPath);
  if (!raw) return undefined;
  if (typeof raw.sessionId !== "string" || typeof raw.paneId !== "string" || typeof raw.timestamp !== "string")
    return undefined;
  return {
    sessionId: raw.sessionId,
    paneId: raw.paneId,
    timestamp: raw.timestamp,
    ...(typeof raw.sessionPath === "string" ? { sessionPath: raw.sessionPath } : {}),
    ...(raw.kind === "canonical" || raw.kind === "temporary" ? { kind: raw.kind } : {}),
    ...(raw.state === "open" || raw.state === "closed" ? { state: raw.state } : {}),
    ...(typeof raw.closedAt === "string" ? { closedAt: raw.closedAt } : {}),
  };
}

export function writeOpenRecord(recordPath: string, record: OpenRecord): void {
  mkdirSync(dirname(recordPath), { recursive: true, mode: 0o700 });
  const temporary = `${recordPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, recordPath);
}

export function temporarySessionPath(paths: CompanionPaths, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(paths.dir, `session-temporary-${stamp}.jsonl`);
}

export type HerdrPane = { pane_id: string; workspace_id?: string; cwd?: string; terminal_title_stripped?: string };

/**
 * Herdr renders a pane title as `<agent> - <session name> - <cwd basename>`.
 *
 * The companion pane cannot be recognised by its command: the launcher execs pi, so
 * `herdr pane process-info` reports `pi` and the launcher path is gone. What survives
 * is the session name `pi --name companion` sets, so match that name exactly. A loose
 * `includes("companion")` would skip every session in a directory called
 * `pi-companion`, and the operator's own pane in that project must still auto-open.
 */
export function isCompanionPane(pane: HerdrPane, workspaceId: string, projectRoot: string): boolean {
  if (pane.workspace_id !== workspaceId || pane.cwd !== projectRoot) return false;
  const title = pane.terminal_title_stripped;
  if (typeof title !== "string") return false;
  return title.replace(/^\S+\s+-\s+/, "") === `${COMPANION_PANE_NAME} - ${basename(projectRoot)}`;
}

/**
 * Pure decision: return true when the auto-open should be skipped.
 *
 * Skip when:
 * (a) The persisted record is for this session and that pane still exists in the
 *     workspace pane list (reload-safe: the record outlives the module).
 * (b) Any pane in the workspace already looks like this project's companion
 *     (covers a reload that lost the record file).
 *
 * A pane closed by hand drops out of the pane list, so it never blocks a later reopen.
 */
export function shouldSkipAutoOpen(
  sessionId: string,
  record: OpenRecord | undefined,
  panes: HerdrPane[],
  workspaceId: string,
  projectRoot: string,
): boolean {
  if (record?.state === "closed") return true;

  const paneIds = new Set(panes.map((p) => p.pane_id));

  // (a) persisted record for this session with pane still alive
  if (record && record.sessionId === sessionId && paneIds.has(record.paneId)) return true;

  // (b) any pane in this workspace already looks like this project's companion
  return panes.some((pane) => isCompanionPane(pane, workspaceId, projectRoot));
}

export type PaneAvailability = { ok: true } | { ok: false; reason: string };

export function paneAvailability(herdrEnv: string | undefined, herdrFound: boolean): PaneAvailability {
  if (herdrEnv !== "1") {
    return { ok: false, reason: "HERDR_ENV is not set, so this session is not running inside Herdr" };
  }
  if (!herdrFound) return { ok: false, reason: "the herdr binary is not on PATH" };
  return { ok: true };
}

export type AutoOpenDecision = { open: true; reason: "eligible" } | { open: false; reason: string };

export function autoOpenDecision(
  hasUI: boolean,
  herdrAvailable: boolean,
  autoOpenSetting: boolean,
  companionMarker: boolean,
  workflowChild: boolean,
): AutoOpenDecision {
  if (!hasUI) return { open: false, reason: "not interactive" };
  if (companionMarker) return { open: false, reason: "companion marker present" };
  if (workflowChild) return { open: false, reason: "workflow child session" };
  if (!autoOpenSetting) return { open: false, reason: "auto-open disabled" };
  if (!herdrAvailable) return { open: false, reason: "Herdr unavailable" };
  return { open: true, reason: "eligible" };
}

// A wide pane splits right; a narrow or tall one splits down, never squeezing an unusable column.
export function splitDirection(size: { width: number; height: number }): "right" | "down" {
  return size.width > size.height ? "right" : "down";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCompanionPaneCommand(launcherPath: string): string {
  return shellQuote(launcherPath);
}

export function buildCompanionPaneScript(input: {
  piPath: string;
  provider: string;
  model: string;
  effort: Effort;
  roleBody: string;
  sessionPath: string;
  callerPaneId?: string;
}): string {
  return [
    "#!/bin/sh",
    `export ${COMPANION_MARKER}=1`,
    ...(input.callerPaneId?.trim()
      ? [`export PI_COMPANION_CALLER_PANE=${shellQuote(input.callerPaneId.trim())}`]
      : []),
    `exec ${shellQuote(input.piPath)} \\\n  --name ${shellQuote("companion")} \\\n  --session ${shellQuote(input.sessionPath)} \\\n  --no-mcp \\\n  --model ${shellQuote(`${input.provider}/${input.model}:${input.effort}`)} \\\n  --tools ${shellQuote(COMPANION_PANE_TOOLS.join(","))} \\\n  --append-system-prompt ${shellQuote(input.roleBody)}`,
    "",
  ].join("\n");
}

export function manualPaneInstructions(command: string, reason: string): string {
  return `companion: pane not opened: ${reason}\nrun it by hand:\n${command}`;
}

export function archiveSessionPath(sessionPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return sessionPath.endsWith(".jsonl")
    ? `${sessionPath.slice(0, -".jsonl".length)}-${stamp}.jsonl`
    : `${sessionPath}-${stamp}`;
}

export function readMeta(path: string): CompanionMeta | undefined {
  const raw = readJsonObject(path);
  if (!raw) return undefined;
  return {
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model : undefined,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    created: typeof raw.created === "string" ? raw.created : "",
  };
}

function writeMeta(path: string, meta: CompanionMeta): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function ensureMeta(paths: CompanionPaths, root: string): CompanionMeta {
  const existing = readMeta(paths.metaPath);
  if (existing) return existing;
  // meta.model is written only by /companion model, so configured defaults keep taking effect.
  const meta: CompanionMeta = { cwd: root, created: new Date().toISOString() };
  writeMeta(paths.metaPath, meta);
  return meta;
}

function extensionAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".pi", "agent");
}

function resolvePiExecutable(): string {
  for (const entry of (process.env.PATH ?? "").split(":")) {
    const candidate = resolve(entry || ".", "pi");
    try {
      accessSync(candidate, X_OK);
      return realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error("Cannot find pi executable on PATH");
}

function writeCompanionPaneScript(paths: CompanionPaths, content: string): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
  writeFileSync(paths.launcherPath, content, { encoding: "utf8", mode: 0o700 });
  chmodSync(paths.launcherPath, 0o700);
}

function companionRolePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "roles", "companion.md");
}

function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].trim() || "Unknown error";
}

type ExecResult = { code: number; stdout: string; stderr: string };

type DispatchResult = {
  content: [{ type: "text"; text: string }];
  details: Record<string, never>;
  isError?: boolean;
};

function exec(file: string, args: string[]): Promise<ExecResult> {
  return new Promise((done) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      done({ code, stdout, stderr });
    });
  });
}

function dispatchFailure(message: string): DispatchResult {
  return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

function normalizeDirective(prompt: unknown): string {
  if (typeof prompt !== "string") throw new Error("prompt must be a string");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt)) {
    throw new Error("prompt contains control characters");
  }
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("prompt must not be empty");
  if (normalized.length > MAX_DIRECTIVE_LENGTH) {
    throw new Error(`prompt exceeds the ${MAX_DIRECTIVE_LENGTH}-character limit`);
  }
  return normalized;
}

async function dispatchDirective(
  ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
  prompt: unknown,
  reason: unknown,
  callerPaneId: string | undefined = process.env.PI_COMPANION_CALLER_PANE?.trim(),
): Promise<DispatchResult> {
  if (!callerPaneId) return dispatchFailure("Dispatch is unavailable: caller pane is unknown.");
  if (!ctx.hasUI) return dispatchFailure("Dispatch is unavailable without an interactive UI.");

  let normalized: string;
  try {
    normalized = normalizeDirective(prompt);
  } catch (error) {
    return dispatchFailure(`Dispatch rejected: ${errorLine(error)}.`);
  }

  const why = typeof reason === "string" && reason.trim() ? reason.trim() : "No reason supplied.";
  const approved = await ctx.ui.confirm(
    "Send directive to caller pane?",
    `This types into pane ${callerPaneId} and starts that agent working.\n\nReason: ${why}\n\nDirective: ${normalized}`,
  );
  if (!approved) return dispatchFailure("Dispatch cancelled; nothing was sent.");

  const result = await exec("herdr", ["pane", "run", callerPaneId, normalized]);
  if (result.code !== 0) {
    return dispatchFailure(`Dispatch failed: ${errorLine(result.stderr || result.stdout || "no response")}.`);
  }
  return {
    content: [{ type: "text", text: `Directive sent to caller pane ${callerPaneId}.` }],
    details: {},
  };
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonField(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function post(pi: ExtensionAPI, ctx: Pick<ExtensionCommandContext, "hasUI">, text: string): void {
  pi.sendMessage({ customType: COMPANION_MESSAGE_TYPE, content: text, display: true });
  // Print mode only emits the final assistant message, so command output must go to stdout there.
  if (!ctx.hasUI) console.log(text);
}

async function createModelRuntimeOptions(
  ctx: ExtensionCommandContext,
  model: NonNullable<ReturnType<ExtensionCommandContext["modelRegistry"]["find"]>>,
): Promise<Pick<CreateAgentSessionOptions, "modelRuntime">> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(model.provider);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
  const hasRuntimeApiKey = ctx.modelRegistry.getProviderAuthStatus(model.provider).source === "runtime";
  if (!nativeProvider && !providerConfig && !hasRuntimeApiKey) return {};

  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  if (nativeProvider) modelRuntime.registerNativeProvider(nativeProvider);
  else if (providerConfig) modelRuntime.registerProvider(model.provider, providerConfig);
  await modelRuntime.refresh({ allowNetwork: false });

  if (hasRuntimeApiKey) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok && auth.apiKey) await modelRuntime.setRuntimeApiKey(model.provider, auth.apiKey);
  }
  return { modelRuntime };
}

async function askTutor(
  ctx: ExtensionCommandContext,
  input: {
    projectRoot: string;
    agentDir: string;
    sessionPath: string;
    rolePath: string;
    roleBody: string;
    provider: string;
    model: string;
    effort: Effort;
    question: string;
  },
): Promise<string> {
  const model = ctx.modelRegistry.find(input.provider, input.model);
  if (!model) throw new Error(`Model not available: ${input.provider}/${input.model}`);

  const { createAgentSession, createExtensionRuntime, SessionManager } = await import(
    "@earendil-works/pi-coding-agent"
  );

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => input.roleBody,
    getSystemPromptSource: () => ({ path: input.rolePath }),
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const options: CreateAgentSessionOptions = {
    cwd: input.projectRoot,
    agentDir: input.agentDir,
    model,
    ...(await createModelRuntimeOptions(ctx, model)),
    thinkingLevel: input.effort,
    tools: [...READ_ONLY_TOOLS],
    resourceLoader,
    sessionManager: SessionManager.open(input.sessionPath, dirname(input.sessionPath), input.projectRoot),
  };

  const { session } = await createAgentSession(options);
  try {
    await session.prompt(input.question);
    const last = session.messages[session.messages.length - 1];
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      throw new Error(last.errorMessage || `Companion run ${last.stopReason}`);
    }
    return session.getLastAssistantText()?.trim() || "(the tutor returned no text)";
  } finally {
    session.dispose();
  }
}

async function countTranscriptEntries(sessionPath: string, projectRoot: string): Promise<number> {
  if (!existsSync(sessionPath)) return 0;
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  return SessionManager.open(sessionPath, dirname(sessionPath), projectRoot).getEntries().length;
}

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readRoleFile(path: string): { model?: string; body: string } {
  try {
    return parseRole(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read role file: ${path}`);
  }
}

type CompanionState = {
  root: string;
  agentDir: string;
  paths: CompanionPaths;
  rolePath: string;
  roleBody: string;
  provider: string;
  model: string;
  effort: Effort;
};

function loadCompanionState(
  ctx: Pick<ExtensionCommandContext, "cwd" | "modelRegistry">,
): CompanionState {
  const agentDir = extensionAgentDir();
  const root = resolveProjectRoot(ctx.cwd);
  const paths = companionPaths(agentDir, root);
  const rolePath = companionRolePath();
  const role = readRoleFile(rolePath);
  if (!role.body) throw new Error(`Role file is empty: ${rolePath}`);

  const meta = ensureMeta(paths, root);
  const resolved = resolveCompanionModel({
    metaModel: meta.model,
    extensionModel: readExtensionModel(agentDir),
    roleModel: role.model,
    aliases: readAliasMap(agentDir),
  });
  if (!resolved.ok) throw new Error(resolved.error);

  return {
    root,
    agentDir,
    paths,
    rolePath,
    roleBody: role.body,
    provider: resolved.provider,
    model: resolved.model,
    effort: resolved.effort,
  };
}

type CompanionOpenOptions = {
  kind?: "canonical" | "temporary";
  autoOpen?: boolean;
};

function acquireOpenLock(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const owner = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          return false;
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") return false;
        }
        unlinkSync(lockPath);
        return acquireOpenLock(lockPath);
      }
    } catch {
      // An unreadable lock is treated as owned; fail closed rather than racing it.
    }
    return false;
  }
}

function releaseOpenLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // The lock may have been reclaimed after a stale process died.
  }
}

async function paneProbe(paneId: string): Promise<"live" | "gone" | "unknown"> {
  const result = await exec("herdr", ["pane", "get", paneId]);
  if (result.code === 0) {
    const parsed = parseJsonText(result.stdout);
    return typeof jsonField(parsed, "result", "pane", "pane_id") === "string" ? "live" : "unknown";
  }
  const error = parseJsonText(result.stdout || result.stderr);
  return jsonField(error, "error", "code") === "pane_not_found" ? "gone" : "unknown";
}

function parseHerdrPanes(result: ExecResult): HerdrPane[] {
  if (result.code !== 0) throw new Error(`herdr pane list failed: ${errorLine(result.stderr || result.stdout || "no response")}`);
  const parsed = parseJsonText(result.stdout);
  const items = jsonField(parsed, "result", "panes");
  if (!Array.isArray(items)) throw new Error("herdr pane list returned invalid JSON");
  const panes: HerdrPane[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).pane_id !== "string") {
      throw new Error("herdr pane list returned an invalid pane");
    }
    panes.push(item as HerdrPane);
  }
  return panes;
}

async function findLiveCompanionPane(
  state: CompanionState,
  options: { allowFallback?: boolean } = {},
): Promise<{ paneId?: string; workspaceId?: string; panes: HerdrPane[] }> {
  const [paneListResult, layoutResult] = await Promise.all([
    exec("herdr", ["pane", "list"]),
    exec("herdr", ["pane", "layout", "--current"]),
  ]);
  const panes = parseHerdrPanes(paneListResult);
  if (layoutResult.code !== 0) {
    throw new Error(`herdr pane layout failed: ${errorLine(layoutResult.stderr || layoutResult.stdout || "no response")}`);
  }
  const layout = parseJsonText(layoutResult.stdout);
  const workspaceId = jsonField(layout, "result", "layout", "workspace_id") as string | undefined;
  if (!workspaceId) throw new Error("herdr pane layout returned invalid JSON");
  const record = readOpenRecord(state.paths.openRecordPath);
  const paneIds = new Set(panes.map((pane) => pane.pane_id));
  if (record) {
    if (paneIds.has(record.paneId)) return { paneId: record.paneId, workspaceId, panes };
    const probe = await paneProbe(record.paneId);
    if (probe === "live") return { paneId: record.paneId, workspaceId, panes };
    if (probe === "unknown") throw new Error(`cannot determine whether companion pane ${record.paneId} is alive`);
  }
  const fallback = options.allowFallback === false
    ? undefined
    : panes.find((pane) => isCompanionPane(pane, workspaceId, state.root));
  return { paneId: fallback?.pane_id, workspaceId, panes };
}

async function reconcileUnknownSplit(
  state: CompanionState,
  beforePanes: HerdrPane[],
  workspaceId: string | undefined,
): Promise<string> {
  if (!workspaceId) return "orphan pane identity is unknown; inspect Herdr manually";
  const [paneListResult, layoutResult] = await Promise.all([
    exec("herdr", ["pane", "list"]),
    exec("herdr", ["pane", "layout", "--current"]),
  ]);
  const panes = parseHerdrPanes(paneListResult);
  if (layoutResult.code !== 0) return "orphan pane cleanup could not verify the workspace";
  const layout = parseJsonText(layoutResult.stdout);
  const currentWorkspace = jsonField(layout, "result", "layout", "workspace_id");
  if (currentWorkspace !== workspaceId) return "orphan pane cleanup found a changed workspace";
  const beforeIds = new Set(beforePanes.map((pane) => pane.pane_id));
  const candidates = panes.filter(
    (pane) => !beforeIds.has(pane.pane_id) && pane.workspace_id === workspaceId && pane.cwd === state.root,
  );
  if (candidates.length !== 1) return `orphan pane cleanup found ${candidates.length} untracked candidates`;
  const cleanup = await exec("herdr", ["pane", "close", candidates[0].pane_id]);
  return cleanup.code === 0
    ? `orphan pane ${candidates[0].pane_id} closed`
    : `orphan cleanup failed: ${errorLine(cleanup.stderr || cleanup.stdout || "no response")}`;
}

async function openCompanionPane(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionCommandContext, "cwd" | "hasUI" | "sessionManager" | "modelRegistry">,
  options: CompanionOpenOptions = {},
): Promise<void> {
  if (process.env[COMPANION_MARKER] === "1") throw new Error("current session is already the companion");

  const state = loadCompanionState(ctx);
  if (!acquireOpenLock(state.paths.openLockPath)) {
    post(pi, ctx, "companion: another pane open is already in progress");
    return;
  }

  try {
    const kind = options.kind ?? "canonical";
    const sessionPath = kind === "temporary" ? temporarySessionPath(state.paths, new Date()) : state.paths.sessionPath;
    const record = readOpenRecord(state.paths.openRecordPath);
    if (options.autoOpen && record?.state === "closed") return;
    const command = buildCompanionPaneCommand(state.paths.launcherPath);

    const herdrFound = (await exec("herdr", ["--version"])).code === 0;
    const availability = paneAvailability(process.env.HERDR_ENV, herdrFound);
    if (!availability.ok) {
      writeCompanionPaneScript(
        state.paths,
        buildCompanionPaneScript({
          piPath: resolvePiExecutable(),
          provider: state.provider,
          model: state.model,
          effort: state.effort,
          roleBody: state.roleBody,
          sessionPath,
          callerPaneId: process.env.HERDR_PANE_ID?.trim(),
        }),
      );
      post(pi, ctx, manualPaneInstructions(command, availability.reason));
      return;
    }

    const live = await findLiveCompanionPane(state);
    if (live.paneId) {
      if (kind === "temporary") {
        post(pi, ctx, `companion: pane ${live.paneId} is already open; close it before starting a new tutor`);
      } else {
        post(pi, ctx, `companion already open in pane ${live.paneId}`);
      }
      return;
    }

    writeCompanionPaneScript(
      state.paths,
      buildCompanionPaneScript({
        piPath: resolvePiExecutable(),
        provider: state.provider,
        model: state.model,
        effort: state.effort,
        roleBody: state.roleBody,
        sessionPath,
        callerPaneId: process.env.HERDR_PANE_ID?.trim(),
      }),
    );

    const layout = parseJsonText((await exec("herdr", ["pane", "layout", "--current"])).stdout);
    const width = jsonField(layout, "result", "layout", "area", "width");
    const height = jsonField(layout, "result", "layout", "area", "height");
    const direction =
      typeof width === "number" && typeof height === "number"
        ? splitDirection({ width, height })
        : "right";

    const split = await exec("herdr", [
      "pane",
      "split",
      "--current",
      "--direction",
      direction,
      "--cwd",
      state.root,
      "--no-focus",
    ]);
    const paneId = jsonField(parseJsonText(split.stdout), "result", "pane", "pane_id");
    if (split.code !== 0 || typeof paneId !== "string" || !paneId) {
      let cleanup = "orphan cleanup not attempted";
      try {
        cleanup = await reconcileUnknownSplit(state, live.panes, live.workspaceId);
      } catch (error) {
        cleanup = `orphan cleanup failed: ${errorLine(error)}`;
      }
      throw new Error(`herdr pane split failed: ${errorLine(split.stderr || split.stdout || "no response")}; ${cleanup}`);
    }

    const run = await exec("herdr", ["pane", "run", paneId, command]);
    if (run.code !== 0) {
      const cleanup = await exec("herdr", ["pane", "close", paneId]);
      const cleanupMessage = cleanup.code === 0 ? "; orphan pane closed" : `; cleanup failed: ${errorLine(cleanup.stderr || cleanup.stdout || "no response")}`;
      throw new Error(
        `pane ${paneId} created but pi did not start: ${errorLine(run.stderr || run.stdout || "no response")}${cleanupMessage}`,
      );
    }
    try {
      writeOpenRecord(state.paths.openRecordPath, {
        sessionId: ctx.sessionManager.getSessionId(),
        paneId,
        timestamp: new Date().toISOString(),
        sessionPath,
        kind,
        state: "open",
      });
    } catch (error) {
      const cleanup = await exec("herdr", ["pane", "close", paneId]);
      const cleanupMessage = cleanup.code === 0 ? "; orphan pane closed" : `; cleanup failed: ${errorLine(cleanup.stderr || cleanup.stdout || "no response")}`;
      throw new Error(`companion state write failed: ${errorLine(error)}${cleanupMessage}`);
    }
    post(pi, ctx, `companion opened in pane ${paneId}\nlauncher: ${state.paths.launcherPath}`);
  } finally {
    releaseOpenLock(state.paths.openLockPath);
  }
}

async function closeCompanionPane(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionCommandContext, "cwd" | "hasUI" | "sessionManager" | "modelRegistry">,
): Promise<void> {
  if (process.env[COMPANION_MARKER] === "1") throw new Error("the companion pane cannot close itself");
  const state = loadCompanionState(ctx);
  if (!acquireOpenLock(state.paths.openLockPath)) {
    post(pi, ctx, "companion: another pane lifecycle operation is already in progress");
    return;
  }

  try {
    const record = readOpenRecord(state.paths.openRecordPath);
    if (!record || record.state === "closed") {
      post(pi, ctx, "companion: no active pane");
      return;
    }

    const herdrFound = (await exec("herdr", ["--version"])).code === 0;
    const availability = paneAvailability(process.env.HERDR_ENV, herdrFound);
    if (!availability.ok) {
      post(pi, ctx, `companion: cannot close pane: ${availability.reason}`);
      return;
    }

    const live = await findLiveCompanionPane(state, { allowFallback: false });
    const now = new Date().toISOString();
    if (!live.paneId) {
      writeOpenRecord(state.paths.openRecordPath, { ...record, state: "closed", closedAt: now });
      post(pi, ctx, "companion: active pane was already gone; state marked closed");
      return;
    }

    const result = await exec("herdr", ["pane", "close", live.paneId]);
    if (result.code !== 0) {
      throw new Error(`herdr pane close failed: ${errorLine(result.stderr || result.stdout || "no response")}`);
    }
    writeOpenRecord(state.paths.openRecordPath, { ...record, paneId: live.paneId, state: "closed", closedAt: now });
    post(pi, ctx, `companion closed in pane ${live.paneId}; transcript preserved`);
  } finally {
    releaseOpenLock(state.paths.openLockPath);
  }
}

async function showStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const agentDir = extensionAgentDir();
  const root = resolveProjectRoot(ctx.cwd);
  const paths = companionPaths(agentDir, root);
  const meta = readMeta(paths.metaPath);
  const role = readRoleFile(companionRolePath());
  const resolved = resolveCompanionModel({
    metaModel: meta?.model,
    extensionModel: readExtensionModel(agentDir),
    roleModel: role.model,
    aliases: readAliasMap(agentDir),
  });
  if (!resolved.ok) {
    post(pi, ctx, `companion: ${resolved.error}`);
    return;
  }

  const record = readOpenRecord(paths.openRecordPath);
  const transcriptPath = record?.sessionPath ?? paths.sessionPath;
  const entries = await countTranscriptEntries(transcriptPath, root);
  const herdrFound = (await exec("herdr", ["--version"])).code === 0;
  const availability = paneAvailability(process.env.HERDR_ENV, herdrFound);
  post(
    pi,
    ctx,
    [
      "companion status",
      `model: ${resolved.provider}/${resolved.model}`,
      `effort: ${resolved.effort}`,
      `model source: ${resolved.source}${resolved.alias ? ` (alias ${resolved.alias})` : ""}`,
      `pane mode: ${availability.ok ? "available" : `unavailable (${availability.reason})`}`,
      `lifecycle: ${record ? record.state ?? "open" : "absent"}${record?.kind ? ` (${record.kind})` : ""}`,
      `pane: ${record?.paneId ?? "none"}`,
      `transcript: ${transcriptPath}`,
      `transcript entries: ${entries}`,
      `transcript bytes: ${fileBytes(transcriptPath)}`,
      `project key: ${paths.key}`,
      `project root: ${root}`,
    ].join("\n"),
  );
}

async function askCompanion(pi: ExtensionAPI, ctx: ExtensionCommandContext, question: string): Promise<void> {
  const state = loadCompanionState(ctx);

  if (ctx.hasUI) ctx.ui.setStatus("companion", "companion: thinking...");
  try {
    const answer = await askTutor(ctx, {
      projectRoot: state.root,
      agentDir: state.agentDir,
      sessionPath: state.paths.sessionPath,
      rolePath: state.rolePath,
      roleBody: state.roleBody,
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      question,
    });
    post(pi, ctx, answer);
  } finally {
    if (ctx.hasUI) ctx.ui.setStatus("companion", undefined);
  }
}

function setCompanionModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, value: string): void {
  const agentDir = extensionAgentDir();
  const root = resolveProjectRoot(ctx.cwd);
  const paths = companionPaths(agentDir, root);
  const resolved = resolveModelRef(value, readAliasMap(agentDir));
  if (!resolved.ok) throw new Error(resolved.error);

  const model = ctx.modelRegistry.find(resolved.provider, resolved.model);
  if (!model) throw new Error(`Model not available: ${resolved.provider}/${resolved.model}`);

  const meta = ensureMeta(paths, root);
  writeMeta(paths.metaPath, { ...meta, model: value.trim() });
  post(
    pi,
    ctx,
    `companion model set: ${resolved.provider}/${resolved.model} (effort ${resolved.effort})`,
  );
}

function setCompanionAutoOpen(pi: ExtensionAPI, ctx: ExtensionCommandContext, enabled: boolean): void {
  const path = companionSettingsPath(extensionAgentDir());
  const settings = readJsonObject(path) ?? {};
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...settings, autoOpen: enabled }, null, 2)}\n`, "utf8");
  post(pi, ctx, `companion auto-open: ${enabled ? "on" : "off"}`);
}

function resetCompanion(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const agentDir = extensionAgentDir();
  const root = resolveProjectRoot(ctx.cwd);
  const paths = companionPaths(agentDir, root);
  if (!existsSync(paths.sessionPath)) {
    post(pi, ctx, `companion: no transcript to archive at ${paths.sessionPath}`);
    return;
  }

  const archived = archiveSessionPath(paths.sessionPath, new Date());
  renameSync(paths.sessionPath, archived);
  post(pi, ctx, `companion transcript archived: ${archived}\nnext question starts a fresh transcript`);
}

export type HostSnapshot = {
  version: 1;
  capturedAt: string;
  sessionId: string;
  cwd: string;
  projectKey: string;
  phase: "idle" | "working";
  model?: string;
  entryCount: number;
  lastEntryType?: string;
  latestUser?: string;
  latestAssistant?: string;
  recentTools: string[];
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function boundedSnapshotText(value: string, limit = 600): string {
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/((?:"?(?:api[_-]?key|token|secret|password|passwd|authorization)"?)\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|\S+)/giu, "$1[REDACTED]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gu, "[REDACTED]");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return boundedSnapshotText(content);
  if (!Array.isArray(content)) return undefined;
  let text = "";
  for (const block of content) {
    const value = recordValue(block);
    if (value?.type !== "text" || typeof value.text !== "string") continue;
    text = boundedSnapshotText(`${text} ${value.text}`);
    if (text.length >= 600) break;
  }
  return text || undefined;
}

export function buildHostSnapshot(input: {
  sessionId: string;
  cwd: string;
  projectKey: string;
  phase: "idle" | "working";
  model?: string;
  entries: readonly unknown[];
  capturedAt?: string;
}): HostSnapshot {
  let latestUser: string | undefined;
  let latestAssistant: string | undefined;
  let lastEntryType: string | undefined;
  const recentTools: string[] = [];
  const entries = input.entries.slice(Math.max(0, input.entries.length - 200));

  for (const rawEntry of entries) {
    const entry = recordValue(rawEntry);
    if (!entry) continue;
    lastEntryType = typeof entry.type === "string" ? entry.type : lastEntryType;
    if (entry.type !== "message") continue;
    const message = recordValue(entry.message);
    if (!message) continue;
    const text = contentText(message.content);
    if (message.role === "user" && text) latestUser = boundedSnapshotText(text);
    if (message.role === "assistant" && text) latestAssistant = boundedSnapshotText(text);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        const value = recordValue(block);
        const name =
          value?.type === "toolCall" && typeof value.name === "string"
            ? value.name
            : value?.type === "tool_use" && typeof value.name === "string"
              ? value.name
              : undefined;
        if (name && recentTools[recentTools.length - 1] !== name && recentTools.length < 10) recentTools.push(name);
      }
    }
  }

  return {
    version: 1,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    sessionId: input.sessionId,
    cwd: input.cwd,
    projectKey: input.projectKey,
    phase: input.phase,
    ...(input.model ? { model: input.model } : {}),
    entryCount: input.entries.length,
    ...(lastEntryType ? { lastEntryType } : {}),
    ...(latestUser ? { latestUser } : {}),
    ...(latestAssistant ? { latestAssistant } : {}),
    recentTools: recentTools.slice(-5),
  };
}

export function formatHostSnapshot(snapshot: HostSnapshot): string {
  return [
    "companion snapshot",
    `captured: ${snapshot.capturedAt}`,
    `session: ${snapshot.sessionId}`,
    `project: ${snapshot.cwd} (${snapshot.projectKey})`,
    `phase: ${snapshot.phase}`,
    ...(snapshot.model ? [`model: ${snapshot.model}`] : []),
    `entries: ${snapshot.entryCount}${snapshot.lastEntryType ? ` (last: ${snapshot.lastEntryType})` : ""}`,
    ...(snapshot.recentTools.length ? [`recent tools: ${snapshot.recentTools.join(", ")}`] : []),
    ...(snapshot.latestUser ? [`latest user: ${snapshot.latestUser}`] : []),
    ...(snapshot.latestAssistant ? [`latest assistant: ${snapshot.latestAssistant}`] : []),
  ].join("\n");
}

export function writeHostSnapshot(path: string, snapshot: HostSnapshot): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function readHostSnapshot(path: string): HostSnapshot | undefined {
  const raw = readJsonObject(path);
  if (!raw || raw.version !== 1 || typeof raw.capturedAt !== "string" || typeof raw.sessionId !== "string") {
    return undefined;
  }
  if (typeof raw.cwd !== "string" || typeof raw.projectKey !== "string") return undefined;
  const phase = raw.phase === "working" ? "working" : raw.phase === "idle" ? "idle" : undefined;
  if (!phase || typeof raw.entryCount !== "number" || !Number.isFinite(raw.entryCount)) return undefined;
  const recentTools = Array.isArray(raw.recentTools)
    ? raw.recentTools.filter((value): value is string => typeof value === "string").slice(-5)
    : [];
  return {
    version: 1,
    capturedAt: raw.capturedAt,
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    projectKey: raw.projectKey,
    phase,
    ...(typeof raw.model === "string" ? { model: boundedSnapshotText(raw.model, 160) } : {}),
    entryCount: Math.max(0, Math.floor(raw.entryCount)),
    ...(typeof raw.lastEntryType === "string" ? { lastEntryType: boundedSnapshotText(raw.lastEntryType, 80) } : {}),
    ...(typeof raw.latestUser === "string" ? { latestUser: boundedSnapshotText(raw.latestUser) } : {}),
    ...(typeof raw.latestAssistant === "string" ? { latestAssistant: boundedSnapshotText(raw.latestAssistant) } : {}),
    recentTools,
  };
}

type HostSnapshotContext = {
  cwd: string;
  model?: { provider: string; id: string };
  sessionManager: { getSessionId(): string; getEntries(): readonly unknown[] };
};

function publishHostSnapshot(ctx: HostSnapshotContext, phase: "idle" | "working"): HostSnapshot | undefined {
  if (process.env[COMPANION_MARKER] === "1") return undefined;
  const snapshot = buildHostSnapshot({
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    projectKey: projectKey(ctx.cwd),
    phase,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    entries: ctx.sessionManager.getEntries(),
  });
  writeHostSnapshot(companionPaths(extensionAgentDir(), resolveProjectRoot(ctx.cwd)).snapshotPath, snapshot);
  return snapshot;
}

function hostSnapshotToolResult(cwd: string): DispatchResult {
  const snapshot = readHostSnapshot(companionPaths(extensionAgentDir(), resolveProjectRoot(cwd)).snapshotPath);
  if (!snapshot) return dispatchFailure("Host snapshot is unavailable; ask the working chat for /companion snapshot.");
  return { content: [{ type: "text", text: formatHostSnapshot(snapshot) }], details: {} };
}

async function handleCompanion(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
): Promise<void> {
  const parsed = parseCompanionArgs(args);
  try {
    switch (parsed.kind) {
      case "open":
        await openCompanionPane(pi, ctx);
        return;
      case "new":
        await openCompanionPane(pi, ctx, { kind: "temporary" });
        return;
      case "close":
        await closeCompanionPane(pi, ctx);
        return;
      case "snapshot": {
        const snapshot = publishHostSnapshot(ctx, ctx.isIdle() ? "idle" : "working");
        post(pi, ctx, snapshot ? formatHostSnapshot(snapshot) : "companion: host snapshot is unavailable in this session");
        return;
      }
      case "status":
        await showStatus(pi, ctx);
        return;
      case "model":
        setCompanionModel(pi, ctx, parsed.value);
        return;
      case "send": {
        const result = await dispatchDirective(ctx, parsed.prompt, "The companion requested this directive.");
        if (result.isError) post(pi, ctx, `companion: ${result.content[0].text}`);
        else post(pi, ctx, result.content[0].text);
        return;
      }
      case "reset":
        resetCompanion(pi, ctx);
        return;
      case "auto":
        setCompanionAutoOpen(pi, ctx, parsed.value);
        return;
      case "question":
        await askCompanion(pi, ctx, parsed.question);
        return;
      case "usage":
        post(pi, ctx, USAGE);
        return;
    }
  } catch (error) {
    post(pi, ctx, `companion: ${errorLine(error)}`);
  }
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 1000) return String(Math.round(Math.max(0, tokens)));
  const thousands = Math.round(tokens / 100) / 10;
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(tokens / 100_000) / 10}M`;
}

export function formatCompanionBadge(input: {
  state: "idle" | "working";
  model?: string;
  entryCount: number;
  tokens?: number;
  contextWindow?: number;
  percent?: number | null;
  width?: number;
}): string {
  const tokens = typeof input.tokens === "number" && Number.isFinite(input.tokens) ? input.tokens : undefined;
  const window =
    typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow) && input.contextWindow > 0
      ? input.contextWindow
      : undefined;
  const percent =
    typeof input.percent === "number" && Number.isFinite(input.percent) ? input.percent : undefined;
  const usage =
    tokens === undefined
      ? "no usage yet"
      : window !== undefined && percent !== undefined
        ? `${formatTokenCount(tokens)}/${formatTokenCount(window)} (${Math.round(percent)}%) ctx`
        : `${formatTokenCount(tokens)} ctx`;
  // An empty model drops its segment, so the narrow form keeps one separator per field.
  const line = [`tutor ${input.state}`, input.model ?? "", usage, `${input.entryCount} entries`]
    .filter((segment) => segment !== "")
    .join(" | ");
  const limit = input.width && input.width > 8 ? input.width : 80;
  // Code points, not UTF-16 units, so a wide grapheme is never cut in half.
  const chars = Array.from(line);
  if (chars.length <= limit) return line;
  return `${chars.slice(0, limit - 3).join("")}...`;
}

export function rightAlign(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return line;
  const chars = Array.from(line);
  if (chars.length >= width) return line;
  return " ".repeat(Math.floor(width) - chars.length) + line;
}

type BadgeContext = {
  cwd: string;
  ui: {
    theme: { fg(color: "accent" | "dim", text: string): string };
    setWidget(
      key: string,
      factory: (
        tui: unknown,
        theme: { fg(color: "accent" | "dim", text: string): string },
      ) => { render(width: number): string[]; invalidate(): void },
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
  };
  getContextUsage(): { tokens?: number | null; contextWindow?: number; percent?: number | null } | undefined;
  sessionManager: { getEntries(): readonly unknown[] };
};

const COMPANION_USAGE_WIDGET = "companion-usage";

function publishCompanionUsage(ctx: BadgeContext, state: "idle" | "working"): void {
  if (process.env[COMPANION_MARKER] !== "1") return;
  const agentDir = extensionAgentDir();
  const root = resolveProjectRoot(ctx.cwd);
  const paths = companionPaths(agentDir, root);
  const resolved = resolveCompanionModel({
    metaModel: readMeta(paths.metaPath)?.model,
    extensionModel: readExtensionModel(agentDir),
    roleModel: readRoleFile(companionRolePath()).model,
    aliases: readAliasMap(agentDir),
  });
  if (!resolved.ok) return;
  const usage = ctx.getContextUsage();
  const model = `${resolved.provider}/${resolved.model}:${resolved.effort}`;
  const entryCount = ctx.sessionManager.getEntries().length;
  ctx.ui.setWidget(
    COMPANION_USAGE_WIDGET,
    (_tui, theme) => ({
      render(width: number): string[] {
        const columns = Number.isFinite(width) && width > 0 ? Math.floor(width) : 80;
        const line = formatCompanionBadge({
          state,
          // Below 40 columns the model is what has to go, or the band overflows.
          model: columns < 40 ? "" : model,
          entryCount,
          tokens: usage?.tokens ?? undefined,
          contextWindow: usage?.contextWindow,
          percent: usage?.percent,
          width: columns,
        });
        if (!line) return [];
        // Padded before colouring: escape sequences would otherwise count toward the width.
        return [theme.fg(state === "working" ? "accent" : "dim", rightAlign(line, columns))];
      },
      invalidate(): void {},
    }),
    { placement: "belowEditor" },
  );
}

export default function companionExtension(pi: ExtensionAPI): void {
  const callerPaneId = process.env.PI_COMPANION_CALLER_PANE?.trim();
  if (process.env[COMPANION_MARKER] === "1") {
    pi.registerTool({
      name: "host_snapshot",
      label: "Host snapshot",
      description: "Read the latest bounded snapshot published by the working Pi session.",
      parameters: HOST_SNAPSHOT_PARAMETERS,
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => hostSnapshotToolResult(ctx.cwd),
    });
  }
  if (process.env[COMPANION_MARKER] === "1" && callerPaneId) {
    pi.registerTool({
      name: "dispatch_directive",
      label: "Dispatch directive",
      description: `After operator confirmation, type a one-line directive into the caller pane's prompt and start that agent working. Newlines collapse to spaces; control characters are rejected; maximum length is ${MAX_DIRECTIVE_LENGTH} characters.`,
      parameters: DISPATCH_PARAMETERS,
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const input = params as { prompt: unknown; reason: unknown };
        return dispatchDirective(ctx, input.prompt, input.reason, callerPaneId);
      },
    });
  }

  pi.on("turn_start", (_event, ctx) => {
    publishCompanionUsage(ctx, "working");
    publishHostSnapshot(ctx, "working");
  });
  pi.on("turn_end", (_event, ctx) => {
    publishCompanionUsage(ctx, "idle");
    publishHostSnapshot(ctx, "idle");
  });

  pi.on("session_start", async (_event, ctx) => {
    publishCompanionUsage(ctx, "idle");
    publishHostSnapshot(ctx, "idle");
    const interactive =
      ctx.hasUI && ctx.mode === "tui" && process.env.GENTLE_PI_AGENTS_CHILD !== "1";
    const companionMarker = process.env[COMPANION_MARKER] === "1";
    // A workflow worker pane is a full interactive TUI session, so the only way to
    // recognise it is the environment @piewf/herdr prefixes onto the command it runs.
    const workflowChild = process.env.PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER === "1";
    const agentDir = extensionAgentDir();
    const autoOpenSetting = readAutoOpenSetting(agentDir);

    if (!interactive || companionMarker || workflowChild || !autoOpenSetting) return;

    const herdrFound = (await exec("herdr", ["--version"])).code === 0;
    const herdrOk = paneAvailability(process.env.HERDR_ENV, herdrFound).ok;

    const decision = autoOpenDecision(interactive, herdrOk, autoOpenSetting, companionMarker, workflowChild);
    if (!decision.open) return;

    try {
      await openCompanionPane(pi, ctx, { autoOpen: true });
    } catch (error) {
      post(pi, ctx, `companion: auto-open failed: ${errorLine(error)}`);
    }
  });

  pi.registerCommand("companion", {
    description: "Read-only tutor chat for this project: ask, open, new, close, snapshot, status, model, reset, auto.",
    handler: async (args, ctx) => handleCompanion(pi, ctx, args),
  });
}
