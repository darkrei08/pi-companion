import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import companionExtension, {
  archiveSessionPath,
  autoOpenDecision,
  buildCompanionPaneCommand,
  buildCompanionPaneScript,
  buildHostSnapshot,
  companionPaths,
  FALLBACK_MODEL,
  formatCompanionBadge,
  formatHostSnapshot,
  formatTokenCount,
  manualPaneInstructions,
  mergeAliasMaps,
  paneAvailability,
  parseCompanionArgs,
  parseRole,
  readAutoOpenSetting,
  readHostSnapshot,
  projectKey,
  readAliasMap,
  readOpenRecord,
  isCompanionPane,
  resolveCompanionModel,
  resolveModelRef,
  rightAlign,
  shellQuote,
  shouldSkipAutoOpen,
  splitDirection,
  temporarySessionPath,
  writeHostSnapshot,
  writeOpenRecord,
} from "../extensions/companion.ts";

const ALIASES = { "companion-model": "cliproxyapi/gemini-3.8-flash-high:medium" };

async function withEnv(values, callback) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function registeredExtension(values) {
  const tools = [];
  const commands = new Map();
  companionExtension({
    on() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.push(tool);
    },
  });
  return { tools, commands };
}

function fakeHerdr() {
  const dir = mkdtempSync(join(tmpdir(), "companion-herdr-"));
  const log = join(dir, "calls.log");
  const binary = join(dir, "herdr");
  writeFileSync(binary, '#!/bin/sh\nprintf \'%s\\t\' "$@" >> "$HERDR_TEST_LOG"\nprintf \'\\n\' >> "$HERDR_TEST_LOG"\n', {
    mode: 0o700,
  });
  return { dir, log, binary };
}

function toolText(result) {
  return result.content.map((block) => block.text ?? "").join("\\n");
}

test("projectKey derives the first 16 hex chars of sha256 of the resolved root", () => {
  assert.equal(projectKey("/tmp/project"), "f630ad93b344dd6b");
  assert.equal(projectKey("/tmp/project/"), "f630ad93b344dd6b");
  assert.match(projectKey("/tmp/other"), /^[0-9a-f]{16}$/);
  assert.notEqual(projectKey("/tmp/project"), projectKey("/tmp/other"));
});

test("companionPaths nests the project under the agent dir key", () => {
  const paths = companionPaths("/agent", "/tmp/project");
  assert.equal(paths.dir, join("/agent", "companion", "f630ad93b344dd6b"));
  assert.equal(paths.sessionPath, join(paths.dir, "session.jsonl"));
  assert.equal(paths.metaPath, join(paths.dir, "meta.json"));
  assert.equal(paths.launcherPath, join(paths.dir, "launcher.sh"));
  assert.equal(paths.openRecordPath, join(paths.dir, "open.json"));
  assert.equal(paths.openLockPath, join(paths.dir, "open.lock"));
  assert.equal(paths.snapshotPath, join(paths.dir, "host-snapshot.json"));
});

test("mergeAliasMaps keeps the first file's value on conflict", () => {
  assert.deepEqual(
    mergeAliasMaps({ a: "first", b: "first" }, { a: "second", c: "second" }),
    { a: "first", b: "first", c: "second" },
  );
});

test("readAliasMap merges roles and workflows, roles win, missing files ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-aliases-"));
  try {
    assert.deepEqual(readAliasMap(dir), {});

    mkdirSync(join(dir, "pi-ext-roles"));
    mkdirSync(join(dir, "pi-extensible-workflows"));
    writeFileSync(
      join(dir, "pi-ext-roles", "settings.json"),
      JSON.stringify({ modelAliases: { shared: "cliproxyapi/roles:high", rolesOnly: "cliproxyapi/roles-only" } }),
    );
    writeFileSync(
      join(dir, "pi-extensible-workflows", "settings.json"),
      JSON.stringify({ modelAliases: { shared: "cliproxyapi/workflows:low", workflowsOnly: "cliproxyapi/wf" } }),
    );

    assert.deepEqual(readAliasMap(dir), {
      shared: "cliproxyapi/roles:high",
      rolesOnly: "cliproxyapi/roles-only",
      workflowsOnly: "cliproxyapi/wf",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModelRef resolves an alias to a provider/model/effort triple", () => {
  assert.deepEqual(resolveModelRef("companion-model", ALIASES), {
    ok: true,
    provider: "cliproxyapi",
    model: "gemini-3.8-flash-high",
    effort: "medium",
    alias: "companion-model",
  });
});

test("resolveModelRef accepts a literal provider/model and defaults effort to medium", () => {
  assert.deepEqual(resolveModelRef("cliproxyapi/gpt-6-sol", ALIASES), {
    ok: true,
    provider: "cliproxyapi",
    model: "gpt-6-sol",
    effort: "medium",
  });
});

test("resolveModelRef reads an explicit effort suffix and bypasses alias lookup", () => {
  assert.deepEqual(resolveModelRef("cliproxyapi/gpt-6-sol:high", ALIASES), {
    ok: true,
    provider: "cliproxyapi",
    model: "gpt-6-sol",
    effort: "high",
  });
});

test("resolveModelRef reports an unknown alias", () => {
  const resolved = resolveModelRef("nope-model", ALIASES);
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /Unknown model alias: nope-model/);
});

test("resolveModelRef rejects an alias that is not a provider/model", () => {
  const resolved = resolveModelRef("broken", { broken: "just-a-name" });
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /does not resolve to provider\/model/);
});

test("resolveCompanionModel prefers meta over setting, role and fallback", () => {
  const resolved = resolveCompanionModel({
    metaModel: "cliproxyapi/meta-only:high",
    extensionModel: "cliproxyapi/setting-only",
    roleModel: "companion-model",
    aliases: ALIASES,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, "meta");
  assert.equal(resolved.provider, "cliproxyapi");
  assert.equal(resolved.model, "meta-only");
  assert.equal(resolved.effort, "high");
});

test("resolveCompanionModel falls back through setting, role, then the constant", () => {
  const fromSetting = resolveCompanionModel({
    extensionModel: "cliproxyapi/setting-only:low",
    roleModel: "companion-model",
    aliases: ALIASES,
  });
  assert.equal(fromSetting.ok, true);
  assert.equal(fromSetting.source, "setting");
  assert.equal(fromSetting.model, "setting-only");
  assert.equal(fromSetting.effort, "low");

  const fromRole = resolveCompanionModel({ roleModel: "companion-model", aliases: ALIASES });
  assert.equal(fromRole.ok, true);
  assert.equal(fromRole.source, "role");
  assert.equal(fromRole.model, "gemini-3.8-flash-high");

  const fromFallback = resolveCompanionModel({ aliases: {} });
  assert.equal(fromFallback.ok, true);
  assert.equal(fromFallback.source, "fallback");
  assert.equal(`${fromFallback.provider}/${fromFallback.model}:${fromFallback.effort}`, FALLBACK_MODEL);
});

test("resolveCompanionModel treats an undefined role alias as unset and uses the constant", () => {
  const resolved = resolveCompanionModel({ roleModel: "companion-model", aliases: {} });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, "fallback");
  assert.equal(`${resolved.provider}/${resolved.model}:${resolved.effort}`, FALLBACK_MODEL);
});

test("resolveCompanionModel does not silently skip a broken meta model", () => {
  const resolved = resolveCompanionModel({
    metaModel: "missing-alias",
    roleModel: "companion-model",
    aliases: ALIASES,
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.source, "meta");
  assert.match(resolved.error, /Unknown model alias/);
});

test("parseCompanionArgs maps every documented form", () => {
  assert.deepEqual(parseCompanionArgs(""), { kind: "usage" });
  assert.deepEqual(parseCompanionArgs("   "), { kind: "usage" });
  assert.deepEqual(parseCompanionArgs("status"), { kind: "status" });
  assert.deepEqual(parseCompanionArgs("open"), { kind: "open" });
  assert.deepEqual(parseCompanionArgs("new"), { kind: "new" });
  assert.deepEqual(parseCompanionArgs("close"), { kind: "close" });
  assert.deepEqual(parseCompanionArgs("snapshot"), { kind: "snapshot" });
  assert.deepEqual(parseCompanionArgs("reset"), { kind: "reset" });
  assert.deepEqual(parseCompanionArgs("auto on"), { kind: "auto", value: true });
  assert.deepEqual(parseCompanionArgs("auto off"), { kind: "auto", value: false });
  assert.deepEqual(parseCompanionArgs("auto"), { kind: "usage" });
  assert.deepEqual(parseCompanionArgs("model"), { kind: "usage" });
  assert.deepEqual(parseCompanionArgs("model companion-model"), {
    kind: "model",
    value: "companion-model",
  });
  assert.deepEqual(parseCompanionArgs("model cliproxyapi/gpt-6-sol:high"), {
    kind: "model",
    value: "cliproxyapi/gpt-6-sol:high",
  });
});

test("parseCompanionArgs treats a lone unknown token as usage and prose as a question", () => {
  assert.deepEqual(parseCompanionArgs("frobnicate"), { kind: "usage" });
  assert.deepEqual(parseCompanionArgs("  why does the queue exist?  "), {
    kind: "question",
    question: "why does the queue exist?",
  });
  assert.deepEqual(parseCompanionArgs("send inspect the queue"), {
    kind: "send",
    prompt: "inspect the queue",
  });
});

test("archiveSessionPath keeps the transcript and appends a sortable timestamp", () => {
  assert.equal(
    archiveSessionPath(
      "/state/companion/abc/session.jsonl",
      new Date("2026-11-06T20:41:22.123Z"),
    ),
    "/state/companion/abc/session-2026-11-06T20-41-22-123Z.jsonl",
  );
});

test("parseRole reads the model alias and keeps the body", () => {
  const role = parseRole("---\nmodel: companion-model\ndescription: x\n---\nBody text\n");
  assert.equal(role.model, "companion-model");
  assert.equal(role.body, "Body text");

  const plain = parseRole("No frontmatter\n");
  assert.equal(plain.model, undefined);
  assert.equal(plain.body, "No frontmatter");
});

const PANE_INPUT = {
  piPath: "/usr/local/bin/pi",
  provider: "cliproxyapi",
  model: "gemini-3.8-flash-high",
  effort: "medium",
  roleBody: "You are the companion chat.",
  sessionPath: "/state/companion/key/session.jsonl",
};

test("buildCompanionPaneCommand runs the stable absolute launcher path", () => {
  assert.equal(buildCompanionPaneCommand("/state/companion/key/launcher.sh"), "'/state/companion/key/launcher.sh'");
});

test("buildCompanionPaneScript marks the launched session as a companion", () => {
  assert.equal(
    buildCompanionPaneScript(PANE_INPUT),
    "#!/bin/sh\nexport PI_COMPANION_SESSION=1\nexec '/usr/local/bin/pi' \\\n  --name 'companion' \\\n  --session '/state/companion/key/session.jsonl' \\\n  --no-mcp \\\n  --model 'cliproxyapi/gemini-3.8-flash-high:medium' \\\n  --tools 'read,grep,find,ls,dispatch_directive,host_snapshot' \\\n  --append-system-prompt 'You are the companion chat.'\n",
  );
});

test("buildCompanionPaneScript exports the caller pane only when one is known", () => {
  assert.match(
    buildCompanionPaneScript({ ...PANE_INPUT, callerPaneId: "w7F:p1" }),
    /export PI_COMPANION_CALLER_PANE='w7F:p1'\nexec/,
  );
  assert.doesNotMatch(buildCompanionPaneScript(PANE_INPUT), /PI_COMPANION_CALLER_PANE/);
});

test("shellQuote keeps the role body a single shell argument, apostrophes included", () => {
  assert.equal(shellQuote("It's fine"), "'It'\\''s fine'");
  assert.equal(shellQuote("two\nlines"), "'two\nlines'");
});

test("dispatch_directive is registered only for a companion with a caller pane", async () => {
  await withEnv({ PI_COMPANION_SESSION: "1", PI_COMPANION_CALLER_PANE: "w7F:p1" }, async () => {
    assert.equal(registeredExtension().tools.some((tool) => tool.name === "dispatch_directive"), true);
  });
  await withEnv({ PI_COMPANION_SESSION: undefined, PI_COMPANION_CALLER_PANE: "w7F:p1" }, async () => {
    assert.equal(registeredExtension().tools.some((tool) => tool.name === "dispatch_directive"), false);
  });
  await withEnv({ PI_COMPANION_SESSION: "1", PI_COMPANION_CALLER_PANE: undefined }, async () => {
    assert.equal(registeredExtension().tools.some((tool) => tool.name === "dispatch_directive"), false);
  });
});

test("approved dispatch collapses newlines and runs herdr once for the caller pane", async () => {
  const herdr = fakeHerdr();
  try {
    await withEnv(
      {
        PI_COMPANION_SESSION: "1",
        PI_COMPANION_CALLER_PANE: "w7F:p1",
        HERDR_TEST_LOG: herdr.log,
        PATH: `${herdr.dir}:${process.env.PATH}`,
      },
      async () => {
        const tool = registeredExtension().tools.find((entry) => entry.name === "dispatch_directive");
        const result = await tool.execute(
          "call-1",
          { prompt: "  inspect\nthe queue\tthen report  ", reason: "The operator asked for the next step." },
          undefined,
          undefined,
          { hasUI: true, ui: { confirm: async () => true } },
        );
        assert.equal(result.isError, undefined);
        assert.match(toolText(result), /w7F:p1/);
        assert.equal(readFileSync(herdr.log, "utf8"), "pane\trun\tw7F:p1\tinspect the queue then report\t\n");
      },
    );
  } finally {
    rmSync(herdr.dir, { recursive: true, force: true });
  }
});

test("declined dispatch sends nothing and returns a failed result", async () => {
  const herdr = fakeHerdr();
  try {
    await withEnv(
      {
        PI_COMPANION_SESSION: "1",
        PI_COMPANION_CALLER_PANE: "w7F:p1",
        HERDR_TEST_LOG: herdr.log,
        PATH: `${herdr.dir}:${process.env.PATH}`,
      },
      async () => {
        const tool = registeredExtension().tools.find((entry) => entry.name === "dispatch_directive");
        const result = await tool.execute(
          "call-2",
          { prompt: "inspect the queue", reason: "The operator asked for the next step." },
          undefined,
          undefined,
          { hasUI: true, ui: { confirm: async () => false } },
        );
        assert.equal(result.isError, true);
        assert.match(toolText(result), /cancel/i);
        assert.equal(existsSync(herdr.log), false);
      },
    );
  } finally {
    rmSync(herdr.dir, { recursive: true, force: true });
  }
});

test("the launcher round-trips a hostile body through POSIX sh", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-launcher-"));
  const launcher = join(dir, "launcher.sh");
  const body = "single ' double \" backslash \\\\ $dollar `backtick`\nline two";
  try {
    writeFileSync(launcher, buildCompanionPaneScript({ ...PANE_INPUT, piPath: "/bin/echo", roleBody: body }), {
      mode: 0o700,
    });
    execFileSync("sh", ["-n", launcher]);
    const output = execFileSync(launcher, { encoding: "utf8" });
    assert.ok(output.includes("--name companion --session /state/companion/key/session.jsonl --no-mcp --model cliproxyapi/gemini-3.8-flash-high:medium --tools read,grep,find,ls,dispatch_directive,host_snapshot --append-system-prompt"));
    assert.ok(output.endsWith(`${body}\n`));
    assert.equal(statSync(launcher).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAutoOpenSetting defaults to off and respects explicit true or false", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-auto-setting-"));
  try {
    assert.equal(readAutoOpenSetting(dir), false);
    mkdirSync(join(dir, "companion"));
    writeFileSync(join(dir, "companion", "settings.json"), JSON.stringify({ autoOpen: false }));
    assert.equal(readAutoOpenSetting(dir), false);
    writeFileSync(join(dir, "companion", "settings.json"), JSON.stringify({ autoOpen: true }));
    assert.equal(readAutoOpenSetting(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("autoOpenDecision covers the interactive Herdr matrix and companion marker guard", () => {
  assert.deepEqual(autoOpenDecision(true, true, true, false, false), { open: true, reason: "eligible" });
  assert.deepEqual(autoOpenDecision(false, true, true, false, false), { open: false, reason: "not interactive" });
  assert.deepEqual(autoOpenDecision(true, false, true, false, false), { open: false, reason: "Herdr unavailable" });
  assert.deepEqual(autoOpenDecision(true, true, false, false, false), { open: false, reason: "auto-open disabled" });
  assert.deepEqual(autoOpenDecision(true, true, true, true, false), { open: false, reason: "companion marker present" });
  assert.deepEqual(autoOpenDecision(true, true, true, false, true), { open: false, reason: "workflow child session" });
});

test("paneAvailability states exactly why the pane cannot open", () => {
  assert.deepEqual(paneAvailability("1", true), { ok: true });
  assert.match(paneAvailability(undefined, true).reason ?? "", /HERDR_ENV is not set/);
  assert.match(paneAvailability("1", false).reason ?? "", /herdr binary is not on PATH/);
});

test("manualPaneInstructions prints the reason and the exact command to run by hand", () => {
  assert.equal(
    manualPaneInstructions("pi --name companion", "the herdr binary is not on PATH"),
    "companion: pane not opened: the herdr binary is not on PATH\nrun it by hand:\npi --name companion",
  );
});

test("splitDirection splits a wide pane right and a tall or square one down", () => {
  assert.equal(splitDirection({ width: 120, height: 40 }), "right");
  assert.equal(splitDirection({ width: 60, height: 100 }), "down");
  assert.equal(splitDirection({ width: 40, height: 40 }), "down");
});

test("readOpenRecord returns undefined for a missing or malformed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-open-record-"));
  try {
    assert.equal(readOpenRecord(join(dir, "open.json")), undefined);
    writeFileSync(join(dir, "open.json"), "not json");
    assert.equal(readOpenRecord(join(dir, "open.json")), undefined);
    writeFileSync(join(dir, "open.json"), JSON.stringify({ sessionId: 1, paneId: "x", timestamp: "t" }));
    assert.equal(readOpenRecord(join(dir, "open.json")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("temporarySessionPath creates a separate sortable transcript path", () => {
  const paths = companionPaths("/agent", "/tmp/project");
  assert.equal(
    temporarySessionPath(paths, new Date("2026-11-08T10:11:12.123Z")),
    join(paths.dir, "session-temporary-2026-11-08T10-11-12-123Z.jsonl"),
  );
});

test("writeOpenRecord / readOpenRecord round-trips the record", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-open-record-"));
  try {
    const record = { sessionId: "sid-1", paneId: "w8F:p7", timestamp: "2026-11-07T10:00:00.000Z" };
    writeOpenRecord(join(dir, "open.json"), record);
    assert.deepEqual(readOpenRecord(join(dir, "open.json")), record);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WORKSPACE = "wXX";
const PROJECT_ROOT = "/root/project";
const COMPANION_PANE = {
  pane_id: "wXX:p7",
  workspace_id: WORKSPACE,
  cwd: PROJECT_ROOT,
  terminal_title_stripped: "\u03c0 - companion - project",
};
const WORKING_PANE = {
  pane_id: "wXX:p1",
  workspace_id: WORKSPACE,
  cwd: PROJECT_ROOT,
  terminal_title_stripped: "\u03c0 - project",
};
const OTHER_PANE = {
  pane_id: "wYY:p1",
  workspace_id: "wYY",
  cwd: PROJECT_ROOT,
  terminal_title_stripped: "\u03c0 - companion - project",
};

test("shouldSkipAutoOpen: an explicitly closed companion stays closed", () => {
  const record = { sessionId: "sid-1", paneId: COMPANION_PANE.pane_id, timestamp: "t", state: "closed" };
  assert.equal(shouldSkipAutoOpen("sid-1", record, [WORKING_PANE], WORKSPACE, PROJECT_ROOT), true);
});

test("shouldSkipAutoOpen: no record, no companion pane => open", () => {
  assert.equal(shouldSkipAutoOpen("sid-1", undefined, [WORKING_PANE], WORKSPACE, PROJECT_ROOT), false);
});

test("shouldSkipAutoOpen (a): same session + pane alive => skip", () => {
  const record = { sessionId: "sid-1", paneId: COMPANION_PANE.pane_id, timestamp: "t" };
  assert.equal(shouldSkipAutoOpen("sid-1", record, [WORKING_PANE, COMPANION_PANE], WORKSPACE, PROJECT_ROOT), true);
});

test("shouldSkipAutoOpen (a): same session but pane gone => do not skip", () => {
  const record = { sessionId: "sid-1", paneId: COMPANION_PANE.pane_id, timestamp: "t" };
  assert.equal(shouldSkipAutoOpen("sid-1", record, [WORKING_PANE], WORKSPACE, PROJECT_ROOT), false);
});

test("shouldSkipAutoOpen (a): different session, pane alive => skip via fallback (b)", () => {
  // The pane is alive and visible in the workspace, so (b) triggers regardless of session mismatch.
  const record = { sessionId: "sid-other", paneId: COMPANION_PANE.pane_id, timestamp: "t" };
  assert.equal(shouldSkipAutoOpen("sid-1", record, [WORKING_PANE, COMPANION_PANE], WORKSPACE, PROJECT_ROOT), true);
});

test("shouldSkipAutoOpen (b): companion pane visible in workspace by title => skip", () => {
  assert.equal(shouldSkipAutoOpen("sid-1", undefined, [WORKING_PANE, COMPANION_PANE], WORKSPACE, PROJECT_ROOT), true);
});

test("shouldSkipAutoOpen (b): companion pane in different workspace does not block", () => {
  assert.equal(shouldSkipAutoOpen("sid-1", undefined, [WORKING_PANE, OTHER_PANE], WORKSPACE, PROJECT_ROOT), false);
});

test("shouldSkipAutoOpen (b): working pane never false-positives as companion", () => {
  // Working pane has same cwd and workspace but no 'companion' segment in its title
  assert.equal(shouldSkipAutoOpen("sid-1", undefined, [WORKING_PANE], WORKSPACE, PROJECT_ROOT), false);
});

test("isCompanionPane matches only the exact 'companion' session name for this root", () => {
  assert.equal(isCompanionPane(COMPANION_PANE, WORKSPACE, PROJECT_ROOT), true);
  assert.equal(isCompanionPane(WORKING_PANE, WORKSPACE, PROJECT_ROOT), false);
  assert.equal(isCompanionPane(OTHER_PANE, WORKSPACE, PROJECT_ROOT), false);
  assert.equal(isCompanionPane(COMPANION_PANE, WORKSPACE, "/root/other"), false);
  assert.equal(isCompanionPane({ ...COMPANION_PANE, terminal_title_stripped: undefined }, WORKSPACE, PROJECT_ROOT), false);
});

test("shouldSkipAutoOpen (b): a session in pi-companion still opens", () => {
  // The operator's own pane in this very repo is titled 'pi-companion'; a substring
  // match would wrongly treat it as the companion and never open one.
  const root = "/root/git/personale/pi-companion";
  const workingPane = {
    pane_id: "wXX:p1",
    workspace_id: WORKSPACE,
    cwd: root,
    terminal_title_stripped: "\u03c0 - pi-companion",
  };
  assert.equal(shouldSkipAutoOpen("sid-1", undefined, [workingPane], WORKSPACE, root), false);
  assert.equal(
    shouldSkipAutoOpen("sid-1", undefined, [{ ...workingPane, terminal_title_stripped: "\u03c0 - companion - pi-companion" }], WORKSPACE, root),
    true,
  );
});

test("formatTokenCount keeps small counts exact and rounds thousands and millions", () => {
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatTokenCount(940), "940");
  assert.equal(formatTokenCount(1000), "1k");
  assert.equal(formatTokenCount(12345), "12.3k");
  assert.equal(formatTokenCount(1048576), "1M");
});

test("formatCompanionBadge renders state, model, usage and entry count on one line", () => {
  assert.equal(
    formatCompanionBadge({
      state: "idle",
      model: "cliproxyapi/gemini-3.8-flash-high:medium",
      entryCount: 7,
      tokens: 12345,
    }),
    "tutor idle | cliproxyapi/gemini-3.8-flash-high:medium | 12.3k ctx | 7 entries",
  );
  assert.equal(
    formatCompanionBadge({ state: "working", model: "m:x", entryCount: 0 }),
    "tutor working | m:x | no usage yet | 0 entries",
  );
});

test("formatCompanionBadge truncates to the column budget in code points", () => {
  const line = formatCompanionBadge({
    state: "working",
    model: "cliproxyapi/gemini-3.8-flash-high:medium",
    entryCount: 12,
    tokens: 1048576,
    width: 40,
  });
  assert.ok(Array.from(line).length <= 40, `too wide: ${line}`);
  assert.ok(line.endsWith("..."), `missing ellipsis: ${line}`);
  assert.equal(Array.from(line).length, 40);

  const measured = formatCompanionBadge({
    state: "working",
    model: "cliproxyapi/gemini-3.8-flash-high:medium",
    entryCount: 12,
    tokens: 1048576,
    contextWindow: 200000,
    percent: 524.3,
    width: 40,
  });
  assert.ok(Array.from(measured).length <= 40, `too wide: ${measured}`);
  assert.ok(measured.endsWith("..."), `missing ellipsis: ${measured}`);
});

test("formatCompanionBadge shows tokens, window and percent when both are known", () => {
  assert.equal(
    formatCompanionBadge({
      state: "idle",
      model: "m:x",
      entryCount: 3,
      tokens: 12345,
      contextWindow: 200000,
      percent: 6.2,
    }),
    "tutor idle | m:x | 12.3k/200k (6%) ctx | 3 entries",
  );
  // An unknown percent falls back to the tokens-only segment.
  assert.equal(
    formatCompanionBadge({ state: "idle", model: "m:x", entryCount: 3, tokens: 12345, contextWindow: 200000, percent: null }),
    "tutor idle | m:x | 12.3k ctx | 3 entries",
  );
  // A known window does not invent a token count.
  assert.equal(
    formatCompanionBadge({ state: "idle", model: "m:x", entryCount: 3, contextWindow: 200000, percent: 6 }),
    "tutor idle | m:x | no usage yet | 3 entries",
  );
});

test("rightAlign pads on the left to the exact width and never cuts", () => {
  assert.equal(rightAlign("abc", 6), "   abc");
  assert.equal(Array.from(rightAlign("x", 80)).length, 80);
  assert.equal(rightAlign("abc", 3), "abc");
  assert.equal(rightAlign("abcdef", 3), "abcdef");
  assert.equal(rightAlign("abc", 0), "abc");
  assert.equal(rightAlign("abc", Number.NaN), "abc");
});

test("formatCompanionBadge leaves a line that fits the budget unchanged", () => {
  const input = { state: "idle", model: "m:x", entryCount: 1, tokens: 200, width: 200 };
  const expected = "tutor idle | m:x | 200 ctx | 1 entries";
  assert.equal(formatCompanionBadge(input), expected);
  assert.equal(formatCompanionBadge({ ...input, width: undefined }), expected);
});

test("buildHostSnapshot returns bounded follow-up context without environment data", () => {
  const snapshot = buildHostSnapshot({
    sessionId: "sid-1",
    cwd: "/root/project",
    projectKey: "abc123",
    phase: "working",
    model: "cliproxyapi/model",
    capturedAt: "2026-11-08T10:11:12.123Z",
    entries: [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "  inspect\nthe queue\t now  " }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "read" },
            { type: "text", text: "The queue is healthy." },
          ],
        },
      },
      { type: "custom", customType: "secret", data: { token: "do-not-copy" } },
    ],
  });

  assert.deepEqual(snapshot, {
    version: 1,
    capturedAt: "2026-11-08T10:11:12.123Z",
    sessionId: "sid-1",
    cwd: "/root/project",
    projectKey: "abc123",
    phase: "working",
    model: "cliproxyapi/model",
    entryCount: 3,
    lastEntryType: "custom",
    latestUser: "inspect the queue now",
    latestAssistant: "The queue is healthy.",
    recentTools: ["read"],
  });
  assert.match(formatHostSnapshot(snapshot), /latest assistant: The queue is healthy\./);
  assert.doesNotMatch(formatHostSnapshot(snapshot), /do-not-copy/);
});

test("buildHostSnapshot redacts credential-like values", () => {
  const snapshot = buildHostSnapshot({
    sessionId: "sid-secret",
    cwd: "/root/project",
    projectKey: "abc123",
    phase: "idle",
    entries: [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "token=secret-value Authorization: Bearer bearer-value \"password\": \"hunter2\" sk-12345678901234567890" }],
        },
      },
    ],
  });
  assert.equal(snapshot.latestUser, "token=[REDACTED] Authorization: [REDACTED] \"password\": [REDACTED] [REDACTED]");
  assert.doesNotMatch(snapshot.latestUser, /secret-value|bearer-value|hunter2|sk-123/);
});

test("writeHostSnapshot / readHostSnapshot round-trips atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-snapshot-"));
  const path = join(dir, "host-snapshot.json");
  try {
    const snapshot = buildHostSnapshot({
      sessionId: "sid-2",
      cwd: "/root/project",
      projectKey: "abc123",
      phase: "idle",
      entries: [],
      capturedAt: "2026-11-08T10:11:12.123Z",
    });
    writeHostSnapshot(path, snapshot);
    assert.deepEqual(readHostSnapshot(path), snapshot);
    assert.equal(existsSync(`${path}.${process.pid}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host_snapshot is registered only inside a companion session", async () => {
  await withEnv({ PI_COMPANION_SESSION: "1", PI_COMPANION_CALLER_PANE: undefined }, async () => {
    assert.equal(registeredExtension().tools.some((tool) => tool.name === "host_snapshot"), true);
  });
  await withEnv({ PI_COMPANION_SESSION: undefined, PI_COMPANION_CALLER_PANE: undefined }, async () => {
    assert.equal(registeredExtension().tools.some((tool) => tool.name === "host_snapshot"), false);
  });
});
