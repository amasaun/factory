import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateViolations, matchesGlob } from "../src/control/guards.ts";

const scope = { permitted: ["src/signup/**", "test/signup/**"], forbidden: ["src/signup/legacy/**"] };
const check = (changedPaths: string[], extra = {}) => candidateViolations({ changedPaths, scope, ...extra });

test("glob matching", () => {
  assert.ok(matchesGlob("src/a/b/c.ts", "src/**"));
  assert.ok(matchesGlob("src/a/b/c.ts", "src/**/*.ts"));
  assert.ok(matchesGlob("src/c.ts", "src/**/*.ts"));
  assert.ok(!matchesGlob("src/a/c.ts", "src/*.ts"));
  assert.ok(!matchesGlob("srcx/c.ts", "src/**"));
  assert.ok(matchesGlob("a.b", "a.b"));
  assert.ok(!matchesGlob("axb", "a.b"));
  assert.ok(matchesGlob("file1.md", "file?.md"));
  assert.ok(!matchesGlob("file/.md", "file?.md"));
});

test("changes inside the approved scope pass", () => {
  assert.deepEqual(check(["src/signup/validate.ts", "test/signup/validate.test.ts"]), []);
});

test("changes outside the approved scope are reported", () => {
  assert.deepEqual(check(["src/billing/charge.ts"]), [
    { path: "src/billing/charge.ts", kind: "out-of-scope", rule: "not matched by scope.permitted" },
  ]);
});

test("forbidden paths win over permitted ones", () => {
  assert.equal(check(["src/signup/legacy/old.ts"])[0]?.kind, "forbidden");
});

test("workflow files and factory policy are protected even when scope permits everything", () => {
  const wide = { permitted: ["**"], forbidden: [] };
  const paths = [
    ".github/workflows/ci.yml",
    ".github/CODEOWNERS",
    "CODEOWNERS",
    ".factory/config.json",
    ".claude/settings.json",
    ".mcp.json",
    ".husky/pre-commit",
    ".gitattributes",
    ".gitmodules",
    ".gitleaks.toml",
  ];
  const violations = candidateViolations({ changedPaths: paths, scope: wide });
  assert.deepEqual(violations.map((v) => v.kind), paths.map(() => "protected"));
});

test("protected paths cannot be reached through different letter case", () => {
  const wide = { permitted: ["**"], forbidden: [] };
  const v = candidateViolations({ changedPaths: [".GitHub/Workflows/ci.yml"], scope: wide });
  assert.equal(v[0]?.kind, "protected");
});

test("a maintenance task may change only the protected paths it lists", () => {
  const maintenance = { maintenancePaths: [".github/workflows/ci.yml"] };
  assert.deepEqual(check([".github/workflows/ci.yml"], maintenance), []);
  assert.equal(check([".github/workflows/release.yml"], maintenance)[0]?.kind, "protected");
});

test("repository policy can add protected paths but not remove them", () => {
  const extra = { extraProtected: ["src/signup/secrets/**"] };
  assert.equal(check(["src/signup/secrets/key.ts"], extra)[0]?.kind, "protected");
  assert.equal(check([".factory/config.json"], extra)[0]?.kind, "protected");
});

test("paths that are not plain repository paths are rejected", () => {
  const bad = ["", "/etc/passwd", "src/../.github/workflows/ci.yml", "src\\signup\\a.ts", "./src/a.ts", "src//a.ts", ".git/config", "sub/.GIT/hooks/pre-push", "src/a\n.ts"];
  const violations = check(bad);
  assert.deepEqual(violations.map((v) => v.kind), bad.map(() => "invalid-path"));
});
