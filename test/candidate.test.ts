import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { IntakeError, intakeCandidate } from "../src/publisher/candidate.ts";

const root = mkdtempSync(join(tmpdir(), "factory-intake-"));
after(() => rmSync(root, { recursive: true, force: true }));

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const write = (dir: string, path: string, text: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const commit = (dir: string, message: string) => {
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD");
};

let n = 0;
/** A publisher clone and a separate worker clone, both at the same base commit. */
function setup() {
  const dir = join(root, `case-${++n}`);
  const origin = join(dir, "origin");
  mkdirSync(origin, { recursive: true });
  sh(origin, "init", "-q", "-b", "main");
  write(origin, "src/signup/validate.js", "export const ok = (u) => true;\n");
  write(origin, ".github/workflows/ci.yml", "name: ci\n");
  const base = commit(origin, "base");
  const publisher = join(dir, "publisher");
  const worker = join(dir, "worker");
  sh(dir, "clone", "-q", origin, publisher);
  sh(dir, "clone", "-q", origin, worker);
  sh(worker, "checkout", "-q", "-b", "work");
  const bundle = (range = `${base}..work`) => {
    const path = join(dir, `out-${++n}.bundle`);
    sh(worker, "bundle", "create", "-q", path, ...range.split(" "));
    return path;
  };
  const intake = (bundlePath: string, extra = {}) =>
    intakeCandidate({
      repoDir: publisher,
      bundlePath,
      baseCommit: base,
      taskId: "42",
      attempt: 1,
      scope: { permitted: ["src/signup/**", "test/signup/**"], forbidden: [] },
      ...extra,
    });
  return { dir, origin, publisher, worker, base, bundle, intake };
}

test("a candidate inside scope is frozen with its commit, tree and paths", () => {
  const s = setup();
  write(s.worker, "src/signup/validate.js", "export const ok = (u) => u.length > 0;\n");
  write(s.worker, "test/signup/validate.test.js", "// test\n");
  const head = commit(s.worker, "reject empty usernames");
  const c = s.intake(s.bundle());
  assert.equal(c.commit, head);
  assert.match(c.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(c.commits, [head]);
  assert.deepEqual(c.changedPaths, ["src/signup/validate.js", "test/signup/validate.test.js"]);
  assert.deepEqual(c.violations, []);
  assert.equal(sh(s.publisher, "rev-parse", c.ref), head);
  // The publisher's working tree is untouched: nothing from the worker was checked out.
  assert.equal(sh(s.publisher, "status", "--porcelain"), "");
  assert.equal(sh(s.publisher, "rev-parse", "HEAD"), s.base);
});

test("editing a workflow file is a violation even when scope permits everything", () => {
  const s = setup();
  write(s.worker, ".github/workflows/ci.yml", "name: ci\non: push\n");
  commit(s.worker, "tweak ci");
  const c = s.intake(s.bundle(), { scope: { permitted: ["**"], forbidden: [] } });
  assert.deepEqual(c.violations.map((v) => [v.path, v.kind]), [[".github/workflows/ci.yml", "protected"]]);
});

test("a protected path touched in one commit and reverted in the next is still reported", () => {
  const s = setup();
  write(s.worker, ".github/workflows/ci.yml", "name: ci\nenv: {LEAK: x}\n");
  commit(s.worker, "sneak");
  write(s.worker, ".github/workflows/ci.yml", "name: ci\n");
  write(s.worker, "src/signup/validate.js", "export const ok = (u) => !!u;\n");
  commit(s.worker, "real change");
  const c = s.intake(s.bundle());
  assert.equal(sh(s.publisher, "diff", "--name-only", s.base, c.commit), "src/signup/validate.js");
  assert.ok(c.violations.some((v) => v.path === ".github/workflows/ci.yml" && v.kind === "protected"));
});

test("a rename out of scope reports the new path", () => {
  const s = setup();
  sh(s.worker, "mv", "src/signup/validate.js", "src/billing.js");
  commit(s.worker, "move");
  const c = s.intake(s.bundle());
  assert.deepEqual(c.changedPaths, ["src/billing.js", "src/signup/validate.js"]);
  assert.deepEqual(c.violations.map((v) => [v.path, v.kind]), [["src/billing.js", "out-of-scope"]]);
});

test("symbolic links are reported", () => {
  const s = setup();
  symlinkSync("../../.github/workflows/ci.yml", join(s.worker, "src/signup/link.yml"));
  commit(s.worker, "link");
  const c = s.intake(s.bundle());
  assert.ok(c.violations.some((v) => v.rule === "symbolic link"));
});

test("a candidate that does not descend from the base is rejected and leaves no ref", () => {
  const s = setup();
  sh(s.worker, "checkout", "-q", "--orphan", "elsewhere");
  write(s.worker, "src/signup/validate.js", "export const ok = () => false;\n");
  commit(s.worker, "unrelated history");
  assert.throws(() => s.intake(s.bundle("elsewhere")), /does not descend/);
  assert.equal(sh(s.publisher, "for-each-ref", "refs/factory/"), "");
});

test("merge commits are rejected", () => {
  const s = setup();
  write(s.worker, "src/signup/a.js", "1\n");
  commit(s.worker, "a");
  sh(s.worker, "checkout", "-q", "-b", "side", s.base);
  write(s.worker, "src/signup/b.js", "2\n");
  commit(s.worker, "b");
  sh(s.worker, "checkout", "-q", "work");
  sh(s.worker, "merge", "-q", "--no-ff", "-m", "merge", "side");
  assert.throws(() => s.intake(s.bundle()), /single-parent/);
});

test("a bundle with more than one head, or no changes, or garbage is rejected", () => {
  const s = setup();
  write(s.worker, "src/signup/a.js", "1\n");
  commit(s.worker, "a");
  sh(s.worker, "branch", "second");
  assert.throws(() => s.intake(s.bundle(`${s.base}..work ${s.base}..second`)), /exactly one head/);

  const junk = join(s.dir, "junk.bundle");
  writeFileSync(junk, "not a bundle");
  assert.throws(() => s.intake(junk), /not a readable Git bundle/);

  const t = setup();
  assert.throws(() => t.intake(t.bundle("work")), /no changes/);
});

test("too many commits are rejected", () => {
  const s = setup();
  for (let i = 0; i < 3; i++) {
    write(s.worker, `src/signup/f${i}.js`, `${i}\n`);
    commit(s.worker, `c${i}`);
  }
  assert.throws(() => s.intake(s.bundle(), { maxCommits: 2 }), /limit is 2/);
});

test("requests with a malformed base, task or attempt are rejected", () => {
  const s = setup();
  write(s.worker, "src/signup/a.js", "1\n");
  commit(s.worker, "a");
  const b = s.bundle();
  assert.throws(() => s.intake(b, { baseCommit: "main" }), IntakeError);
  assert.throws(() => s.intake(b, { taskId: "../x" }), IntakeError);
  assert.throws(() => s.intake(b, { attempt: 0 }), IntakeError);
  assert.throws(() => s.intake(b, { baseCommit: "0".repeat(40) }), /does not contain the base/);
});
