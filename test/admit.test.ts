import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { EVENT_MARKER } from "../src/control/github-ledger.ts";
import { renderTask } from "../src/control/issue-task.ts";
import type { Task } from "../src/control/task.ts";
import { fullTask, scores } from "./helpers.ts";

// The admit command run for real, against a stand-in GitHub API and a stand-in model CLI.
const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "factory-admit-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const BOT = "github-actions[bot]";
const world = {
  issue: { number: 7, state: "open", body: "", user: { login: "owner" } } as Record<string, unknown>,
  comments: [] as { id: number; body: string; user: { login: string } }[],
  labels: new Set<string>(),
  runsToday: 1,
  skippedToday: 0,
  nextId: 1,
};
function handle(req: IncomingMessage, res: ServerResponse, body: string) {
  const url = new URL(req.url!, "http://x");
  const path = url.pathname.replace("/repos/acme/app", "");
  const send = (status: number, json?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(json === undefined ? undefined : JSON.stringify(json));
  };
  if (path === "/issues/7" && req.method === "GET") return send(200, world.issue);
  if (path === "/issues/7/comments" && req.method === "GET") return send(200, Number(url.searchParams.get("page") ?? 1) === 1 ? world.comments : []);
  if (path === "/issues/7/comments" && req.method === "POST") {
    const c = { id: world.nextId++, body: JSON.parse(body).body, user: { login: BOT } };
    world.comments.push(c);
    return send(201, c);
  }
  if (path === "/issues/7/labels" && req.method === "POST") {
    for (const l of JSON.parse(body).labels) world.labels.add(l);
    return send(200, []);
  }
  if (path.startsWith("/issues/7/labels/") && req.method === "DELETE") {
    const name = decodeURIComponent(path.split("/").pop()!);
    if (!world.labels.delete(name)) return send(404, { message: "Label does not exist" });
    return send(200, []);
  }
  if (path === "/actions/workflows/factory.yml/runs") {
    // Runs that really ran, plus ones skipped because some other label was added.
    const runs = [...Array(world.runsToday).fill({ conclusion: null }), ...Array(world.skippedToday).fill({ conclusion: "skipped" })];
    return send(200, { total_count: runs.length, workflow_runs: Number(url.searchParams.get("page") ?? 1) === 1 ? runs : [] });
  }
  send(404, { message: `Not Found: ${req.method} ${path}` });
}
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => handle(req, res, body));
});
let apiUrl = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

// A repository checkout with the policy file committed.
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const repo = join(dir, "repo");
mkdirSync(join(repo, ".factory"), { recursive: true });
writeFileSync(
  join(repo, ".factory/config.json"),
  JSON.stringify({ version: 1, baseBranch: "main", approvers: ["owner"], commands: { setup: [], test: [["node", "--test"]] }, budget: { runsPerDay: 3 } }),
);
for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "base"]]) spawnSync("git", args, { cwd: repo, env: gitEnv });

// The stand-in model CLI returns whatever scores the test put in a file, and records that it was called.
const scoreFile = join(dir, "scores.json");
const calls = join(dir, "calls.log");
const fakeClaude = join(dir, "claude.mjs");
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
let prompt = ""; for await (const c of process.stdin) prompt += c;
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ model: a[a.indexOf("--model") + 1], tools: a[a.indexOf("--tools") + 1], cwd: process.cwd(), sawTicket: prompt.includes("TICKET-BEGIN") }) + "\\n");
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.012, modelUsage: { "claude-sonnet-5-5": {} }, structured_output: JSON.parse(readFileSync(${JSON.stringify(scoreFile)}, "utf8")) }));
`,
);
chmodSync(fakeClaude, 0o755);

let outDir = "";
beforeEach(() => {
  world.issue = { number: 7, state: "open", body: renderTask(fullTask()), user: { login: "owner" } };
  world.comments = [];
  world.labels = new Set(["factory"]);
  world.runsToday = 1;
  world.skippedToday = 0;
  writeFileSync(scoreFile, JSON.stringify(scores(5)));
  writeFileSync(calls, "");
  outDir = mkdtempSync(join(dir, "out-"));
});

// The stand-in API lives in this process, so the command must run without blocking it.
function admit(env: Record<string, string> = {}): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "src/cli.ts"), "admit"], {
      env: {
        ...process.env,
        GITHUB_API_URL: apiUrl, GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/app", GITHUB_REF: "refs/heads/main",
        GITHUB_WORKFLOW_REF: "acme/app/.github/workflows/factory.yml@refs/heads/main",
        GITHUB_OUTPUT: join(outDir, "gh-output"), GITHUB_STEP_SUMMARY: "",
        FACTORY_REPO_DIR: repo, FACTORY_ISSUE: "7", FACTORY_ACTOR: "owner", FACTORY_DEFAULT_BRANCH: "main",
        FACTORY_RUN_URL: "https://example.invalid/run/1", FACTORY_APP_LOGIN: BOT, FACTORY_OUT: outDir,
        FACTORY_CLAUDE: fakeClaude, CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const events = () => world.comments.filter((c) => c.body.startsWith(EVENT_MARKER));
const notes = () => world.comments.filter((c) => !c.body.startsWith(EVENT_MARKER)).map((c) => c.body);
const modelCalls = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("a ticket that passes is admitted, marked in progress, and its score recorded", async () => {
  const r = await admit();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(events().length, 4);
  assert.ok(events()[0]!.body.includes("ticket evaluation 5 of 5"));
  assert.ok(world.labels.has("factory:in-progress"));
  assert.ok(world.labels.has("factory"));
  const admitted = JSON.parse(readFileSync(join(outDir, "task.json"), "utf8"));
  assert.equal(admitted.ticketScore, 5);
  assert.deepEqual(admitted.task, fullTask());
  assert.match(readFileSync(join(outDir, "gh-output"), "utf8"), /^base=[0-9a-f]{40}\nmax_attempts=2\n$/);
  // The evaluator ran once, with no tools, the configured model, outside the repository, on the ticket.
  const [call] = modelCalls();
  assert.equal(modelCalls().length, 1);
  assert.deepEqual([call.model, call.tools, call.sawTicket], ["sonnet", "", true]);
  assert.notEqual(call.cwd, repo);
  assert.ok(existsSync(join(outDir, "evaluation-result.json")));
});

test("a ticket scoring under the bar is refused: label removed, reasons posted, nothing recorded", async () => {
  writeFileSync(scoreFile, JSON.stringify(scores(5, { testCases: 3, readiness: 4 })));
  const r = await admit();
  assert.equal(r.status, 1);
  assert.equal(events().length, 0);
  assert.ok(!world.labels.has("factory"));
  assert.ok(!world.labels.has("factory:in-progress"));
  assert.equal(notes().length, 1);
  assert.ok(notes()[0]!.includes("the ticket evaluation did not pass"));
  assert.ok(notes()[0]!.includes("| Test cases | 3 |"));
  assert.ok(notes()[0]!.includes("it can be started again"));
  assert.ok(!existsSync(join(outDir, "task.json")));
});

test("a ticket with a missing piece is refused without spending a model call", async () => {
  const t: Task = fullTask();
  delete t.testCases;
  world.issue.body = renderTask(t);
  const r = await admit();
  assert.equal(r.status, 1);
  assert.equal(modelCalls().length, 0);
  assert.equal(events().length, 0);
  assert.ok(notes()[0]!.includes("there are no test cases"));
  assert.ok(!world.labels.has("factory"));
});

test("a ticket for a different repository is refused", async () => {
  const t = fullTask();
  t.repository = "olivo/web";
  world.issue.body = renderTask(t);
  const r = await admit();
  assert.equal(r.status, 1);
  assert.ok(notes()[0]!.includes("the task is for olivo/web, but this is acme/app"));
  assert.equal(events().length, 0);
});

test("a label from someone who is not an approver starts nothing", async () => {
  const r = await admit({ FACTORY_ACTOR: "stranger" });
  assert.equal(r.status, 1);
  assert.equal(modelCalls().length, 0);
  assert.equal(events().length, 0);
  assert.ok(notes()[0]!.includes("stranger is not listed as an approver"));
  assert.ok(!world.labels.has("factory"));
});

test("the daily run limit stops a run before the evaluator is called", async () => {
  world.runsToday = 4;
  const r = await admit();
  assert.equal(r.status, 1);
  assert.equal(modelCalls().length, 0);
  assert.ok(notes()[0]!.includes("limit of 3 factory runs for today"));
  world.runsToday = 3;
  world.comments = [];
  world.labels = new Set(["factory"]);
  assert.equal((await admit()).status, 0);
});

test("runs skipped because another label was added do not use up the daily limit", async () => {
  world.runsToday = 3;
  world.skippedToday = 40;
  assert.equal((await admit()).status, 0);
});

test("an issue without a valid task is refused with the reasons", async () => {
  world.issue.body = "Please make it faster.";
  const r = await admit();
  assert.equal(r.status, 1);
  assert.ok(notes()[0]!.includes("does not contain a valid task"));
  assert.ok(notes()[0]!.includes("no factory task block"));
});

test("a task that already has a run is not started again and is left untouched", async () => {
  assert.equal((await admit()).status, 0);
  const before = world.comments.length;
  const again = await admit();
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has a run/);
  assert.equal(world.comments.length, before);
  assert.ok(world.labels.has("factory:in-progress"));
});

test("a run cannot be admitted from a branch other than the default", async () => {
  const r = await admit({ GITHUB_REF: "refs/heads/feature" });
  assert.equal(r.status, 1);
  assert.equal(world.comments.length, 0);
});

test("without a model credential nothing is evaluated or recorded", async () => {
  const r = await admit({ CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no model credential/);
  assert.equal(events().length, 0);
});
