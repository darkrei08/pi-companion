import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  archiveSessionPath,
  autoOpenDecision,
  buildCompanionPaneCommand,
  buildCompanionPaneScript,
  companionPaths,
  FALLBACK_MODEL,
  manualPaneInstructions,
  mergeAliasMaps,
  paneAvailability,
  parseCompanionArgs,
  parseRole,
  readAutoOpenSetting,
  projectKey,
  readAliasMap,
  readOpenRecord,
  isCompanionPane,
  resolveCompanionModel,
  resolveModelRef,
  shellQuote,
  shouldSkipAutoOpen,
  splitDirection,
  writeOpenRecord,
} from "../extensions/companion.ts";

const ALIASES = { "companion-model": "cliproxyapi/gemini-3.8-flash-high:medium" };

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
};

test("buildCompanionPaneCommand runs the stable absolute launcher path", () => {
  assert.equal(buildCompanionPaneCommand("/state/companion/key/launcher.sh"), "'/state/companion/key/launcher.sh'");
});

test("buildCompanionPaneScript marks the launched session as a companion", () => {
  assert.equal(
    buildCompanionPaneScript(PANE_INPUT),
    "#!/bin/sh\nexport PI_COMPANION_SESSION=1\nexec '/usr/local/bin/pi' \\\n  --name 'companion' \\\n  --model 'cliproxyapi/gemini-3.8-flash-high:medium' \\\n  --tools 'read,grep,find,ls' \\\n  --append-system-prompt 'You are the companion chat.'\n",
  );
});

test("shellQuote keeps the role body a single shell argument, apostrophes included", () => {
  assert.equal(shellQuote("It's fine"), "'It'\\''s fine'");
  assert.equal(shellQuote("two\nlines"), "'two\nlines'");
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
    assert.ok(output.includes("--name companion --model cliproxyapi/gemini-3.8-flash-high:medium --tools read,grep,find,ls --append-system-prompt"));
    assert.ok(output.endsWith(`${body}\n`));
    assert.equal(statSync(launcher).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAutoOpenSetting defaults to on and respects an explicit false", () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-auto-setting-"));
  try {
    assert.equal(readAutoOpenSetting(dir), true);
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
  assert.deepEqual(autoOpenDecision(true, true, true, false), { open: true, reason: "eligible" });
  assert.deepEqual(autoOpenDecision(false, true, true, false), { open: false, reason: "not interactive" });
  assert.deepEqual(autoOpenDecision(true, false, true, false), { open: false, reason: "Herdr unavailable" });
  assert.deepEqual(autoOpenDecision(true, true, false, false), { open: false, reason: "auto-open disabled" });
  assert.deepEqual(autoOpenDecision(true, true, true, true), { open: false, reason: "companion marker present" });
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
