import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
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
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const FALLBACK_MODEL = "cliproxyapi/gemini-3.8-flash-high:medium";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
const DEFAULT_EFFORT: Effort = "medium";

export const USAGE = [
  "companion usage",
  "/companion <question>                            ask the read-only tutor about this project",
  "/companion status                                show model, effort, transcript size and project key",
  "/companion model <alias|provider/model[:effort]> set this project's model",
  "/companion reset                                 archive the transcript and start a fresh one",
].join("\n");

export type ModelSource = "meta" | "setting" | "role" | "fallback";

export type ResolvedModel =
  | { ok: true; provider: string; model: string; effort: Effort; source: ModelSource; alias?: string }
  | { ok: false; source: ModelSource; error: string };

export type ParsedCommand =
  | { kind: "usage" }
  | { kind: "status" }
  | { kind: "reset" }
  | { kind: "model"; value: string }
  | { kind: "question"; question: string };

export type CompanionMeta = { model?: string; cwd: string; created: string };

// NOTE: a lone token is treated as a mistyped subcommand; questions have spaces.
export function parseCompanionArgs(args: string): ParsedCommand {
  const text = args.trim();
  if (!text) return { kind: "usage" };
  if (text === "status") return { kind: "status" };
  if (text === "reset") return { kind: "reset" };
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

// Optional global default for this extension: <agentDir>/companion/settings.json {"model": "alias|provider/model[:effort]"}
export function readExtensionModel(agentDir: string): string | undefined {
  const model = readJsonObject(join(agentDir, "companion", "settings.json"))?.model;
  return typeof model === "string" && model.trim() ? model : undefined;
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
};

export function companionPaths(agentDir: string, root: string): CompanionPaths {
  const key = projectKey(root);
  const dir = join(agentDir, "companion", key);
  return { key, dir, sessionPath: join(dir, "session.jsonl"), metaPath: join(dir, "meta.json") };
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
  return configured ? configured : join(homedir(), ".pi", "agent");
}

function companionRolePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "roles", "companion.md");
}

function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0].trim() || "Unknown error";
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
  post(
    pi,
    ctx,
    [
      "companion status",
      `model: ${resolved.provider}/${resolved.model}`,
      `effort: ${resolved.effort}`,
      `model source: ${resolved.source}${resolved.alias ? ` (alias ${resolved.alias})` : ""}`,
      `transcript: ${paths.sessionPath}`,
      `transcript entries: ${entries}`,
      `transcript bytes: ${fileBytes(paths.sessionPath)}`,
      `project key: ${paths.key}`,
      `project root: ${root}`,
    ].join("\n"),
  );
}

async function askCompanion(pi: ExtensionAPI, ctx: ExtensionCommandContext, question: string): Promise<void> {
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

  if (ctx.hasUI) ctx.ui.setStatus("companion", "companion: thinking...");
  try {
    const answer = await askTutor(ctx, {
      projectRoot: root,
      agentDir,
      sessionPath: paths.sessionPath,
      rolePath,
      roleBody: role.body,
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
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
      case "status":
        await showStatus(pi, ctx);
        return;
      case "model":
        setCompanionModel(pi, ctx, parsed.value);
        return;
      case "reset":
        resetCompanion(pi, ctx);
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
  pi.registerCommand("companion", {
    description: "Read-only tutor chat for this project: ask, status, model, reset.",
    handler: async (args, ctx) => handleCompanion(pi, ctx, args),
  });
}
