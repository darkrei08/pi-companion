import { execFile } from "node:child_process";
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
  writeFileSync,
  X_OK,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CreateAgentSessionOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";

export const COMPANION_MESSAGE_TYPE = "companion";
export const COMPANION_MARKER = "PI_COMPANION_SESSION";
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const FALLBACK_MODEL = "cliproxyapi/gemini-3.8-flash-high:medium";
const AUTO_OPEN_ENTRY = "companion_auto_opened";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
const DEFAULT_EFFORT: Effort = "medium";

export const USAGE = [
  "companion usage",
  "/companion <question>                            ask the read-only tutor about this project",
  "/companion open                                  open the tutor as a Pi session in a pane beside this one",
  "/companion status                                show model, effort, transcript size and project key",
  "/companion model <alias|provider/model[:effort]> set this project's model",
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
  | { kind: "status" }
  | { kind: "reset" }
  | { kind: "auto"; value: boolean }
  | { kind: "model"; value: string }
  | { kind: "question"; question: string };

export type CompanionMeta = { model?: string; cwd: string; created: string };

// NOTE: a lone token is treated as a mistyped subcommand; questions have spaces.
export function parseCompanionArgs(args: string): ParsedCommand {
  const text = args.trim();
  if (!text) return { kind: "usage" };
  if (text === "open") return { kind: "open" };
  if (text === "status") return { kind: "status" };
  if (text === "reset") return { kind: "reset" };
  if (text === "auto on") return { kind: "auto", value: true };
  if (text === "auto off") return { kind: "auto", value: false };
  if (text === "auto") return { kind: "usage" };
  if (text === "model") return { kind: "usage" };
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
  return readJsonObject(companionSettingsPath(agentDir))?.autoOpen !== false;
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
  };
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
  alreadyOpened: boolean,
  autoOpenSetting: boolean,
  companionMarker: boolean,
): AutoOpenDecision {
  if (!hasUI) return { open: false, reason: "not interactive" };
  if (companionMarker) return { open: false, reason: "companion marker present" };
  if (alreadyOpened) return { open: false, reason: "already opened" };
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
}): string {
  return [
    "#!/bin/sh",
    `export ${COMPANION_MARKER}=1`,
    `exec ${shellQuote(input.piPath)} \\\n  --name ${shellQuote("companion")} \\\n  --model ${shellQuote(`${input.provider}/${input.model}:${input.effort}`)} \\\n  --tools ${shellQuote(READ_ONLY_TOOLS.join(","))} \\\n  --append-system-prompt ${shellQuote(input.roleBody)}`,
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

function exec(file: string, args: string[]): Promise<ExecResult> {
  return new Promise((done) => {
    execFile(file, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      done({ code, stdout, stderr });
    });
  });
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

function post(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string): void {
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

function loadCompanionState(ctx: ExtensionCommandContext): CompanionState {
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

async function openCompanionPane(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (process.env[COMPANION_MARKER] === "1") throw new Error("current session is already the companion");

  const state = loadCompanionState(ctx);
  writeCompanionPaneScript(
    state.paths,
    buildCompanionPaneScript({
      piPath: resolvePiExecutable(),
      provider: state.provider,
      model: state.model,
      effort: state.effort,
      roleBody: state.roleBody,
    }),
  );
  const command = buildCompanionPaneCommand(state.paths.launcherPath);

  const herdrFound = (await exec("herdr", ["--version"])).code === 0;
  const availability = paneAvailability(process.env.HERDR_ENV, herdrFound);
  if (!availability.ok) {
    post(pi, ctx, manualPaneInstructions(command, availability.reason));
    return;
  }

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
    throw new Error(`herdr pane split failed: ${errorLine(split.stderr || split.stdout || "no response")}`);
  }

  const run = await exec("herdr", ["pane", "run", paneId, command]);
  if (run.code !== 0) {
    throw new Error(
      `pane ${paneId} created but pi did not start: ${errorLine(run.stderr || run.stdout || "no response")}`,
    );
  }
  pi.appendEntry(AUTO_OPEN_ENTRY, { paneId });
  post(pi, ctx, `companion opened in pane ${paneId}\nlauncher: ${state.paths.launcherPath}`);
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

  const entries = await countTranscriptEntries(paths.sessionPath, root);
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
      `transcript: ${paths.sessionPath}`,
      `transcript entries: ${entries}`,
      `transcript bytes: ${fileBytes(paths.sessionPath)}`,
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
      case "status":
        await showStatus(pi, ctx);
        return;
      case "model":
        setCompanionModel(pi, ctx, parsed.value);
        return;
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

export default function companionExtension(pi: ExtensionAPI): void {
  let autoOpenAttempted = false;

  pi.on("session_start", async (_event, ctx) => {
    const interactive =
      ctx.hasUI && ctx.mode === "tui" && process.env.GENTLE_PI_AGENTS_CHILD !== "1";
    const companionMarker = process.env[COMPANION_MARKER] === "1";
    const agentDir = extensionAgentDir();
    const alreadyOpened = autoOpenAttempted || ctx.sessionManager.getEntries().some(
      (entry) => entry.type === "custom" && entry.customType === AUTO_OPEN_ENTRY,
    );
    const autoOpenSetting = readAutoOpenSetting(agentDir);

    if (!interactive || companionMarker || alreadyOpened || !autoOpenSetting) return;

    const herdrFound = (await exec("herdr", ["--version"])).code === 0;
    const decision = autoOpenDecision(
      interactive,
      paneAvailability(process.env.HERDR_ENV, herdrFound).ok,
      alreadyOpened,
      autoOpenSetting,
      companionMarker,
    );
    if (!decision.open) return;

    autoOpenAttempted = true;
    try {
      await openCompanionPane(pi, ctx);
    } catch (error) {
      post(pi, ctx, `companion: auto-open failed: ${errorLine(error)}`);
    }
  });

  pi.registerCommand("companion", {
    description: "Read-only tutor chat for this project: ask, open, status, model, reset, auto.",
    handler: async (args, ctx) => handleCompanion(pi, ctx, args),
  });
}
