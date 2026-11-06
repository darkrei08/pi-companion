import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  archiveSessionPath,
  companionPaths,
  FALLBACK_MODEL,
  mergeAliasMaps,
  parseCompanionArgs,
  parseRole,
  projectKey,
  readAliasMap,
  resolveCompanionModel,
  resolveModelRef,
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
  assert.deepEqual(parseCompanionArgs("reset"), { kind: "reset" });
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
