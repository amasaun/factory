import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { encodeEvent } from "../src/control/github-ledger.ts";
import { renderTask } from "../src/control/issue-task.ts";
import type { Task } from "../src/control/task.ts";
import { Gh } from "../src/plugin/gh.ts";
import { configFile, initProblems, workflowFile } from "../src/plugin/init.ts";
import { attention, renderStatus, repoStatus } from "../src/plugin/status.ts";
import { parseConfig } from "../src/run/config.ts";
import { ev, toReady } from "./helpers.ts";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "factory-plugin-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [join(root, "src/plugin-cli.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

const task: Task = {
  goal: "Add a truncate function.",
  acceptance: [{ id: "AC-1", behavior: "truncate('abcdef', 4) returns 'abc…'", evidence: "unit test" }],
  scenarios: { omitted: "not implemented yet" },
  nonGoals: [],
  scope: { components: ["text"], permitted: ["src/**"], forbidden: [] },
  risk: { level: "low", concerns: [] },
};

// A stand-in for the GitHub CLI that answers `gh api <path>` from a fixture file.
const APP = "github-actions[bot]";
const events = (list: ReturnType<typeof toReady>) => list.map((e, i) => ({ id: 100 + i, user: { login: APP }, body: encodeEvent(i + 1, e) }));
const fixtures: Record<string, unknown[]> = {
  "repos/acme/app/issues": [
    { number: 1, title: "Published task", state: "open", body: renderTask(task) },
    { number: 2, title: "Not started | with a pipe", state: "open", body: `intro\n${renderTask(task)}` },
    { number: 3, title: "An ordinary bug report", state: "open", body: "no task here" },
    { number: 4, title: "A pull request", state: "open", body: renderTask(task), pull_request: {} },
    { number: 5, title: "Stopped for a person", state: "open", body: renderTask(task) },
    { number: 6, title: "Merged task", state: "closed", body: renderTask(task) },
    { number: 7, title: "Tampered log", state: "open", body: renderTask(task) },
  ],
  "repos/acme/app/pulls": [
    { number: 11, head: { ref: "factory/1" }, merged_at: null, state: "open" },
    { number: 16, head: { ref: "factory/6" }, merged_at: "2026-11-15T00:00:00Z", state: "closed" },
    { number: 20, head: { ref: "feature/x" }, merged_at: null, state: "open" },
  ],
  "repos/acme/app/issues/1/comments": [...events([...toReady().slice(0, -1)]), { id: 500, user: { login: "someone" }, body: "nice" }],
  "repos/acme/app/issues/2/comments": [{ id: 1, user: { login: "someone" }, body: encodeEvent(1, ev("approval-verified")) }],
  "repos/acme/app/issues/5/comments": events([ev("approval-verified"), ev("admitted"), ev("capacity-granted"), ev("lease-issued"), ev("environment-ready", { lease: 1 }), ev("baseline-unclassified", { lease: 1, resumeTargets: ["building"], cause: "baseline checks did not pass" })]),
  "repos/acme/app/issues/6/comments": events([...toReady().slice(0, -1)]),
  "repos/acme/app/issues/7/comments": [{ id: 1, user: { login: APP }, body: encodeEvent(2, ev("admitted")) }],
};
const fixtureFile = join(dir, "fixtures.json");
writeFileSync(fixtureFile, JSON.stringify(fixtures));
const fakeGh = join(dir, "gh");
writeFileSync(
  fakeGh,
  `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const [cmd, path, ...rest] = process.argv.slice(2);
if (cmd !== "api") { console.error("unsupported"); process.exit(2); }
const data = JSON.parse(readFileSync(${JSON.stringify(fixtureFile)}, "utf8"))[path.split("?")[0]];
if (!data) { console.error("HTTP 404: Not Found"); process.exit(1); }
const jq = rest[rest.indexOf("--jq") + 1];
process.stdout.write(execFileSync("jq", ["-c", jq], { input: JSON.stringify(data), encoding: "utf8" }));
`,
);
chmodSync(fakeGh, 0o755);
const hasJq = spawnSync("jq", ["--version"]).status === 0;

test("status reads each task's state from its issue, events and pull request", { skip: !hasJq }, async () => {
  const r = await repoStatus(new Gh(fakeGh), "acme/app");
  assert.equal(r.error, null);
  const byIssue = Object.fromEntries(r.tasks.map((t) => [t.issue, t]));
  assert.deepEqual(Object.keys(byIssue).map(Number).sort((a, b) => a - b), [1, 2, 5, 6, 7]);
  assert.equal(byIssue[1]!.state, "ci-pending");
  assert.equal(byIssue[1]!.pullRequest, 11);
  // An event written by anyone but the factory does not start a run.
  assert.equal(byIssue[2]!.state, "not started");
  assert.equal(byIssue[5]!.state, "needs-human");
  assert.equal(byIssue[5]!.detail, "baseline checks did not pass");
  // The log stops at publication; a merged pull request finishes the story.
  assert.equal(byIssue[6]!.state, "merged");
  assert.equal(byIssue[7]!.state, "unreadable");
  assert.deepEqual(r.tasks.map((t) => [t.issue, attention(t)]), [[1, "act"], [2, "act"], [5, "act"], [6, "done"], [7, "act"]]);
  // A failed or stopped task stops asking for attention once its issue is closed.
  assert.equal(attention({ ...byIssue[5]!, issueOpen: false }), "done");
  assert.equal(attention({ ...byIssue[1]!, issueOpen: false }), "act");
});

test("the status view says what needs the reader and survives awkward titles", { skip: !hasJq }, async () => {
  const text = renderStatus([await repoStatus(new Gh(fakeGh), "acme/app"), await repoStatus(new Gh(fakeGh), "acme/missing")]);
  assert.ok(text.includes("## acme/app"));
  assert.ok(text.includes("| #1 | Published task | ci-pending | #11 | yes |"));
  assert.ok(text.includes("Not started / with a pipe"));
  assert.ok(text.includes("| #6 | Merged task | merged | #16 | no |"));
  assert.ok(text.includes("## acme/missing"));
  assert.ok(text.includes("Could not read this repository"));
  assert.ok(text.includes("4 task(s) need you, 0 in progress, across 2 repositories."));
});

test("the plugin only reads run history", async () => {
  const comments = new Gh(fakeGh).comments("acme/app");
  assert.throws(() => comments.create(1, "x"), /never writes/);
  assert.throws(() => comments.delete(1), /never writes/);
});

test("a missing gh is reported plainly", async () => {
  const r = await repoStatus(new Gh(join(dir, "no-such-gh")), "acme/app");
  assert.match(r.error ?? "", /not installed/);
});

test("setup files are valid and pin a release", () => {
  const o = { baseBranch: "main", approvers: ["owner"], test: [["npm", "test"]], setup: [["npm", "ci"]], version: "v0.1.0" };
  assert.deepEqual(initProblems(o), []);
  const config = parseConfig(configFile(o));
  assert.deepEqual(config.commands, { setup: [["npm", "ci"]], test: [["npm", "test"]] });
  assert.deepEqual(config.approvers, ["owner"]);
  const wf = workflowFile(o);
  assert.ok(wf.includes("uses: amasaun/factory/.github/workflows/run.yml@v0.1.0"));
  assert.ok(wf.includes("group: factory-${{ inputs.issue }}"));
  assert.ok(wf.includes("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}"));
  assert.ok(!wf.includes("@main"));
  for (const bad of [{ version: "main" }, { approvers: [] }, { approvers: ["bad login"] }, { test: [] }, { test: [["npm test", ""]] }, { baseBranch: "a b" }]) {
    assert.ok(initProblems({ ...o, ...bad }).length > 0, JSON.stringify(bad));
  }
});

test("init-files writes both files once and refuses to overwrite", () => {
  const repo = mkdtempSync(join(dir, "repo-"));
  const args = ["init-files", "--dir", repo, "--base-branch", "main", "--approver", "owner", "--test", '[["node","--test"]]', "--version", "v0.1.0"];
  const first = cli(args);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(repo, ".factory/config.json")));
  assert.ok(existsSync(join(repo, ".github/workflows/factory.yml")));
  const second = cli(args);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already exists/);
  const bad = cli(["init-files", "--dir", mkdtempSync(join(dir, "repo-")), "--base-branch", "main", "--approver", "owner", "--test", "npm test", "--version", "v0.1.0"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--test must be JSON/);
});

test("the task command prints an issue body for a valid task and explains an invalid one", () => {
  const good = join(dir, "task.json");
  writeFileSync(good, JSON.stringify(task));
  const ok = cli(["task", good]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, renderTask(task));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...task, acceptance: [] }));
  const no = cli(["task", bad]);
  assert.equal(no.status, 1);
  assert.match(no.stderr, /at least one criterion/);
});

test("the repository list is kept in one file and rejects junk", () => {
  const registry = join(dir, "reg", "repos.json");
  const env = { FACTORY_REGISTRY: registry };
  assert.match(cli(["repos", "list"], env).stdout, /no repositories registered/);
  assert.equal(cli(["repos", "add", "acme/app"], env).status, 0);
  cli(["repos", "add", "acme/app"], env);
  cli(["repos", "add", "olivo/site"], env);
  assert.deepEqual(JSON.parse(readFileSync(registry, "utf8")), { repos: ["acme/app", "olivo/site"] });
  cli(["repos", "remove", "acme/app"], env);
  assert.equal(cli(["repos", "list"], env).stdout.trim(), "olivo/site");
  assert.equal(cli(["repos", "add", "not a repo"], env).status, 1);
  assert.equal(cli(["status"], { FACTORY_REGISTRY: join(dir, "empty.json") }).status, 1);
});

test("the status command runs end to end through the stand-in gh", { skip: !hasJq }, () => {
  const out = cli(["status", "--repo", "acme/app"], { FACTORY_GH: fakeGh });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes("| #5 | Stopped for a person | needs-human |"));
  const json = cli(["status", "--repo", "acme/app", "--json"], { FACTORY_GH: fakeGh });
  assert.equal(JSON.parse(json.stdout)[0].tasks.length, 5);
});

test("the plugin manifest, marketplace entry and skills agree with each other", () => {
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
  const market = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  assert.equal(plugin.name, "factory");
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, "./");
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  const skills = readdirSync(join(root, "skills"));
  assert.deepEqual(skills.sort(), ["init", "run", "spec", "status"]);
  for (const s of skills) {
    const text = readFileSync(join(root, "skills", s, "SKILL.md"), "utf8");
    assert.match(text, /^---\nname: /, s);
    // Every helper command a skill mentions exists.
    for (const m of text.matchAll(/plugin-cli\.ts (\w[\w-]*)/g)) {
      assert.ok(["task", "init-files", "repos", "status"].includes(m[1]!), `${s}: ${m[1]}`);
    }
  }
  // Starting a run is the person's approval, so the run skill must never be auto-invoked or told to dispatch.
  const run = readFileSync(join(root, "skills/run/SKILL.md"), "utf8");
  assert.match(run, /disable-model-invocation: true/);
  assert.match(run, /Do not start the run yourself/);
});
