import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { intakeCandidate } from "../src/publisher/candidate.ts";
import {
  type PullRequest,
  type PullRequests,
  ForeignCommitError,
  PublishError,
  branchFor,
  ensurePullRequest,
  pushCandidate,
  taskMarker,
} from "../src/publisher/publish.ts";

const root = mkdtempSync(join(tmpdir(), "factory-publish-"));
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
function setup() {
  const dir = join(root, `case-${++n}`);
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  sh(seed, "init", "-q", "-b", "main");
  write(seed, "src/a.js", "export const a = 1;\n");
  const base = commit(seed, "base");
  const origin = join(dir, "origin.git");
  sh(dir, "clone", "-q", "--bare", seed, origin);
  const publisher = join(dir, "publisher");
  const worker = join(dir, "worker");
  sh(dir, "clone", "-q", origin, publisher);
  sh(dir, "clone", "-q", origin, worker);
  sh(worker, "checkout", "-q", "-b", "work");
  let attempt = 0;
  /** Commit a change in the worker and take it through intake. */
  const candidate = (path: string, text: string) => {
    write(worker, path, text);
    commit(worker, `change ${path}`);
    const bundle = join(dir, `b-${++n}.bundle`);
    sh(worker, "bundle", "create", "-q", bundle, `${base}..work`);
    return intakeCandidate({
      repoDir: publisher, bundlePath: bundle, baseCommit: base, taskId: "42", attempt: ++attempt,
      scope: { permitted: ["src/**"], forbidden: [] },
    });
  };
  const remoteRef = (ref: string) => sh(origin, "rev-parse", "--verify", "-q", ref);
  return { dir, origin, publisher, worker, base, candidate, remoteRef };
}

test("the first publication creates factory/<task> at exactly the candidate", () => {
  const s = setup();
  const c = s.candidate("src/a.js", "export const a = 2;\n");
  const r = pushCandidate({ repoDir: s.publisher, remote: "origin", taskId: "42", candidate: c, expectedRemote: null });
  assert.deepEqual(r, { branch: "factory/42", commit: c.commit, pushed: true });
  assert.equal(s.remoteRef("refs/heads/factory/42"), c.commit);
  assert.equal(s.remoteRef("refs/heads/main"), s.base);
});

test("publishing the same candidate again is a no-op", () => {
  const s = setup();
  const c = s.candidate("src/a.js", "export const a = 2;\n");
  const req = { repoDir: s.publisher, remote: "origin", taskId: "42", candidate: c, expectedRemote: null };
  pushCandidate(req);
  assert.equal(pushCandidate(req).pushed, false);
  // Also a no-op when the caller's expectation is stale, as after a crash between push and record.
  assert.equal(pushCandidate({ ...req, expectedRemote: s.base }).pushed, false);
});

test("a claim ref at the base is replaced by the candidate", () => {
  const s = setup();
  sh(s.publisher, "push", "-q", "origin", `${s.base}:refs/heads/factory/42`);
  const c = s.candidate("src/a.js", "export const a = 2;\n");
  pushCandidate({ repoDir: s.publisher, remote: "origin", taskId: "42", candidate: c, expectedRemote: s.base });
  assert.equal(s.remoteRef("refs/heads/factory/42"), c.commit);
});

test("a repaired candidate replaces the previous one", () => {
  const s = setup();
  const first = s.candidate("src/a.js", "export const a = 2;\n");
  pushCandidate({ repoDir: s.publisher, remote: "origin", taskId: "42", candidate: first, expectedRemote: null });
  sh(s.worker, "reset", "-q", "--hard", s.base);
  const second = s.candidate("src/a.js", "export const a = 3;\n");
  pushCandidate({ repoDir: s.publisher, remote: "origin", taskId: "42", candidate: second, expectedRemote: first.commit });
  assert.equal(s.remoteRef("refs/heads/factory/42"), second.commit);
});

test("a commit someone else put on the branch stops publication and is left intact", () => {
  const s = setup();
  const first = s.candidate("src/a.js", "export const a = 2;\n");
  pushCandidate({ repoDir: s.publisher, remote: "origin", taskId: "42", candidate: first, expectedRemote: null });

  const human = join(s.dir, "human");
  sh(s.dir, "clone", "-q", "-b", "factory/42", s.origin, human);
  write(human, "src/a.js", "export const a = 'by hand';\n");
  const foreign = commit(human, "manual fix");
  sh(human, "push", "-q", "origin", "factory/42");

  const second = s.candidate("src/b.js", "export const b = 1;\n");
  assert.throws(
    () => pushCandidate({ repoDir: s.publisher, remote: "origin", taskId: "42", candidate: second, expectedRemote: first.commit }),
    ForeignCommitError,
  );
  assert.equal(s.remoteRef("refs/heads/factory/42"), foreign);
});

test("a branch that exists when none is expected stops publication", () => {
  const s = setup();
  sh(s.publisher, "push", "-q", "origin", `${s.base}:refs/heads/factory/42`);
  const c = s.candidate("src/a.js", "export const a = 2;\n");
  assert.throws(
    () => pushCandidate({ repoDir: s.publisher, remote: "origin", taskId: "42", candidate: c, expectedRemote: null }),
    ForeignCommitError,
  );
});

test("a candidate with violations is never pushed", () => {
  const s = setup();
  const c = s.candidate("docs/readme.md", "out of scope\n");
  assert.ok(c.violations.length > 0);
  assert.throws(
    () => pushCandidate({ repoDir: s.publisher, remote: "origin", taskId: "42", candidate: c, expectedRemote: null }),
    PublishError,
  );
  assert.throws(() => s.remoteRef("refs/heads/factory/42"));
});

test("the branch name comes only from a numeric task id", () => {
  assert.equal(branchFor("7"), "factory/7");
  for (const bad of ["", "0", "main", "7/../../main", "7 ", "-1", "07"]) {
    assert.throws(() => branchFor(bad), PublishError, bad);
  }
});

class FakePulls implements PullRequests {
  prs: PullRequest[] = [];
  async listOpenByHead(head: string) {
    return this.prs.filter((p) => p.head === head);
  }
  async create(pr: { head: string; base: string; title: string; body: string; draft: true }) {
    const made = { number: this.prs.length + 1, head: pr.head, base: pr.base, draft: pr.draft, body: pr.body };
    this.prs.push(made);
    return made;
  }
  async update(number: number, changes: { title: string; body: string }) {
    const pr = this.prs.find((p) => p.number === number)!;
    pr.body = changes.body;
    return pr;
  }
}
const request = { taskId: "42", base: "main", title: "Add truncate", body: "evidence v1" };

test("one draft pull request is created, then updated on later calls", async () => {
  const fake = new FakePulls();
  assert.deepEqual(await ensurePullRequest(fake, request), { number: 1, created: true });
  assert.equal(fake.prs[0]?.draft, true);
  assert.equal(fake.prs[0]?.head, "factory/42");
  assert.deepEqual(await ensurePullRequest(fake, { ...request, body: "evidence v2" }), { number: 1, created: false });
  assert.equal(fake.prs.length, 1);
  assert.ok(fake.prs[0]?.body.includes("evidence v2"));
  assert.ok(fake.prs[0]?.body.startsWith(taskMarker("42")));
});

test("a pull request the factory did not open is not taken over", async () => {
  const fake = new FakePulls();
  fake.prs.push({ number: 9, head: "factory/42", base: "main", draft: false, body: "opened by hand" });
  await assert.rejects(ensurePullRequest(fake, request), /not opened by the factory/);
  assert.equal(fake.prs[0]?.body, "opened by hand");
});

test("unexpected pull request state is refused", async () => {
  const wrongBase = new FakePulls();
  wrongBase.prs.push({ number: 1, head: "factory/42", base: "release", draft: true, body: taskMarker("42") });
  await assert.rejects(ensurePullRequest(wrongBase, request), /targets release/);

  const two = new FakePulls();
  two.prs.push(
    { number: 1, head: "factory/42", base: "main", draft: true, body: taskMarker("42") },
    { number: 2, head: "factory/42", base: "main", draft: true, body: taskMarker("42") },
  );
  await assert.rejects(ensurePullRequest(two, request), /at most one/);

  await assert.rejects(ensurePullRequest(new FakePulls(), { ...request, base: "factory/7" }), PublishError);
});
