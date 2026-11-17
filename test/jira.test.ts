import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { EVENT_MARKER } from "../src/control/github-ledger.ts";
import { extractTask } from "../src/control/issue-task.ts";
import type { Task } from "../src/control/task.ts";
import { type AdfNode, JIRA_TASK_MARKER, adfComment, adfText, extractTaskFromAdf, renderTaskForJira } from "../src/jira/adf.ts";
import { Jira, JiraError, isJiraApprover, isJiraKey, labelAddedBy } from "../src/jira/client.ts";
import { parseConfig } from "../src/run/config.ts";
import { fullTask, scores } from "./helpers.ts";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "factory-jira-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------- ADF helpers

const p = (text: string): AdfNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const code = (text: string): AdfNode => ({ type: "codeBlock", attrs: { language: "json" }, content: [{ type: "text", text }] });
const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", attrs: { version: 1 }, content });
const ticketBody = (task: Task) => doc(p("Add a helper."), { type: "heading", content: [{ type: "text", text: "Task data" }] }, p(JIRA_TASK_MARKER), code(JSON.stringify(task, null, 2)));

test("a task is read from a Jira description: the marker line, then a code block", () => {
  assert.deepEqual(extractTaskFromAdf(ticketBody(fullTask())), { ok: true, task: fullTask() });
  // Jira's collapsible section and panels are looked inside.
  const nested = doc(p("intro"), { type: "expand", attrs: { title: "Task data" }, content: [p(`${JIRA_TASK_MARKER} `), code(JSON.stringify(fullTask()))] });
  assert.deepEqual(extractTaskFromAdf(nested), { ok: true, task: fullTask() });
});

test("a description without a usable task says what is wrong", () => {
  const problem = (d: unknown) => {
    const r = extractTaskFromAdf(d);
    return r.ok ? "" : r.problems.join(" | ");
  };
  assert.match(problem(null), /no description/);
  assert.match(problem(doc(p("Please make it faster."))), /no factory task/);
  assert.match(problem(doc(p(JIRA_TASK_MARKER), p("not a code block"))), /followed directly by a code block/);
  assert.match(problem(doc(p(JIRA_TASK_MARKER), code("{nope"))), /does not parse/);
  assert.match(problem(doc(p(JIRA_TASK_MARKER), code('{"goal":"x"}'))), /missing required field/);
  assert.match(problem(doc(p(JIRA_TASK_MARKER), code("{}"), p(JIRA_TASK_MARKER), code("{}"))), /more than one/);
  // The marker inside the JSON itself is not a second marker.
  const t = fullTask();
  t.nonGoals.push(`mentions ${JIRA_TASK_MARKER}`);
  assert.equal(extractTaskFromAdf(ticketBody(t)).ok, true);
});

test("the Markdown written to Jira carries the same task the factory reads from a GitHub issue", () => {
  const md = renderTaskForJira(fullTask());
  assert.ok(md.startsWith("Add a truncate helper"));
  assert.ok(md.includes("As a user browsing a list, I want long titles shortened"));
  assert.ok(md.includes(`\n${JIRA_TASK_MARKER}\n\n\`\`\`json\n`));
  assert.ok(!/<[a-z!]/.test(md), "no HTML: Jira would drop it");
  assert.deepEqual(JSON.parse(md.split("```json\n")[1]!.split("\n```")[0]!), fullTask());
});

test("comments are built as text, never as markup", () => {
  const c = adfComment(["Did not pass.", "", "Second line <b>x</b> [link](http://evil.example)"], [{ label: "Test cases: 2", value: "no edge cases @someone" }]);
  assert.equal(c.type, "doc");
  assert.equal(c.content!.length, 3);
  assert.equal(adfText(c.content![1]), "Second line <b>x</b> [link](http://evil.example)");
  assert.equal(c.content![2]!.type, "bulletList");
  assert.equal(adfText(c.content![2]), "Test cases: 2: no edge cases @someone");
  // Only plain text nodes: nothing that Jira would render as a link or a mention.
  const types = new Set<string>();
  const walk = (n: AdfNode) => (types.add(n.type), (n.content ?? []).forEach(walk));
  walk(c);
  assert.deepEqual([...types].sort(), ["bulletList", "doc", "listItem", "paragraph", "text"]);
});

test("ticket keys are recognised strictly", () => {
  for (const ok of ["OLV-1", "AB-123", "PLAT2-4567", "A_B-9"]) assert.ok(isJiraKey(ok), ok);
  for (const bad of ["", "olv-1", "OLV-0", "OLV", "OLV-", "OLV-1/../x", "OLV-1 ", "1AB-2", "OLV-01"]) assert.ok(!isJiraKey(bad), bad);
});

// ---------------------------------------------------------------- a stand-in Jira

const APPROVER = { accountId: "acc-ada", emailAddress: "ada@client.example", displayName: "Ada" };
const STRANGER = { accountId: "acc-eve", emailAddress: "eve@client.example", displayName: "Eve" };
/** The client's workflow, as in their Jira: transitions are named separately from the statuses they lead to. */
const WORKFLOW: Record<string, { id: string; name: string; to: string }[]> = {
  Defined: [{ id: "11", name: "Start work", to: "In Progress" }, { id: "12", name: "Transition to", to: "Closed (Superseded)" }],
  "In Progress": [{ id: "21", name: "Ready for test", to: "Testing" }, { id: "22", name: "Transition to", to: "Defined" }],
  Testing: [{ id: "31", name: "Transition to", to: "Defined" }, { id: "32", name: "Refactoring Work", to: "In Progress" }, { id: "33", name: "Merging to Production", to: "Done" }],
  Done: [],
};
const jira = {
  issue: { key: "OLV-42", status: "Defined", labels: ["factory"] as string[], description: null as unknown, summary: "Add truncate" },
  histories: [] as { created: string; author: typeof APPROVER; items: { field: string; fromString: string; toString: string }[] }[],
  comments: [] as AdfNode[],
  auth: [] as (string | undefined)[],
};
const github = {
  issues: [] as { number: number; title: string; body: string; labels: string[] }[],
  comments: new Map<number, { id: number; body: string; user: { login: string } }[]>(),
  labels: new Map<number, Set<string>>(),
  runsToday: 1,
  nextId: 1,
};
const BOT = "github-actions[bot]";

function send(res: ServerResponse, status: number, json?: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json === undefined ? undefined : JSON.stringify(json));
}
function handleJira(req: IncomingMessage, res: ServerResponse, body: string) {
  jira.auth.push(req.headers.authorization);
  const path = new URL(req.url!, "http://x").pathname.replace("/rest/api/3", "");
  if (req.headers.authorization !== `Basic ${Buffer.from("bot@client.example:jira-token").toString("base64")}`) return send(res, 401, { errorMessages: ["Unauthorized"] });
  if (path === "/issue/OLV-42" && req.method === "GET") {
    return send(res, 200, {
      key: jira.issue.key,
      fields: { summary: jira.issue.summary, description: jira.issue.description, labels: jira.issue.labels, status: { name: jira.issue.status } },
      changelog: { histories: jira.histories },
    });
  }
  if (path === "/issue/OLV-42" && req.method === "PUT") {
    for (const op of JSON.parse(body).update.labels) if (op.remove) jira.issue.labels = jira.issue.labels.filter((l) => l !== op.remove);
    return send(res, 204);
  }
  if (path === "/issue/OLV-42/transitions" && req.method === "GET") {
    return send(res, 200, { transitions: (WORKFLOW[jira.issue.status] ?? []).map((t) => ({ id: t.id, name: t.name, to: { name: t.to } })) });
  }
  if (path === "/issue/OLV-42/transitions" && req.method === "POST") {
    const t = (WORKFLOW[jira.issue.status] ?? []).find((x) => x.id === JSON.parse(body).transition.id);
    if (!t) return send(res, 400, { errorMessages: ["Transition is not valid"] });
    jira.issue.status = t.to;
    return send(res, 204);
  }
  if (path === "/issue/OLV-42/comment" && req.method === "POST") {
    jira.comments.push(JSON.parse(body).body);
    return send(res, 201, {});
  }
  send(res, 404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
}
function handleGitHub(req: IncomingMessage, res: ServerResponse, body: string) {
  const url = new URL(req.url!, "http://x");
  const path = url.pathname.replace("/repos/acme/app", "");
  const first = Number(url.searchParams.get("page") ?? 1) === 1;
  let m: RegExpExecArray | null;
  if (path === "/issues" && req.method === "POST") {
    const b = JSON.parse(body);
    const issue = { number: 100 + github.issues.length, title: b.title, body: b.body, labels: b.labels ?? [] };
    github.issues.push(issue);
    github.labels.set(issue.number, new Set(issue.labels));
    return send(res, 201, issue);
  }
  if (path === "/issues" && req.method === "GET") {
    const label = url.searchParams.get("labels");
    return send(res, 200, first ? github.issues.filter((i) => i.labels.includes(label!)) : []);
  }
  if ((m = /^\/issues\/(\d+)\/comments$/.exec(path))) {
    const n = Number(m[1]);
    if (req.method === "GET") return send(res, 200, first ? (github.comments.get(n) ?? []) : []);
    const c = { id: github.nextId++, body: JSON.parse(body).body, user: { login: BOT } };
    github.comments.set(n, [...(github.comments.get(n) ?? []), c]);
    return send(res, 201, c);
  }
  if ((m = /^\/issues\/(\d+)\/labels$/.exec(path)) && req.method === "POST") {
    const set = github.labels.get(Number(m[1])) ?? new Set();
    for (const l of JSON.parse(body).labels) set.add(l);
    github.labels.set(Number(m[1]), set);
    return send(res, 200, []);
  }
  if (path === "/actions/workflows/factory.yml/runs") return send(res, 200, { workflow_runs: first ? Array(github.runsToday).fill({ conclusion: null }) : [] });
  send(res, 404, { message: `Not Found: ${req.method} ${path}` });
}
const collect = (handler: typeof handleJira) =>
  createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => handler(req, res, body));
  });
const jiraServer = collect(handleJira);
const githubServer = collect(handleGitHub);
let jiraUrl = "";
let githubUrl = "";
before(async () => {
  await Promise.all([new Promise<void>((r) => jiraServer.listen(0, "127.0.0.1", r)), new Promise<void>((r) => githubServer.listen(0, "127.0.0.1", r))]);
  jiraUrl = `http://127.0.0.1:${(jiraServer.address() as AddressInfo).port}`;
  githubUrl = `http://127.0.0.1:${(githubServer.address() as AddressInfo).port}`;
});
after(() => (jiraServer.close(), githubServer.close()));

const labelled = (by: typeof APPROVER, when = "2026-11-16T10:00:00.000+0000") => ({ created: when, author: by, items: [{ field: "labels", fromString: "", toString: "factory" }] });
let outDir = "";
const scoreFile = join(dir, "scores.json");
beforeEach(() => {
  jira.issue = { key: "OLV-42", status: "Defined", labels: ["factory"], description: ticketBody(fullTask()), summary: "Add truncate" };
  jira.histories = [labelled(APPROVER)];
  jira.comments = [];
  jira.auth = [];
  github.issues = [];
  github.comments = new Map();
  github.labels = new Map();
  github.runsToday = 1;
  writeFileSync(scoreFile, JSON.stringify(scores(5)));
  outDir = mkdtempSync(join(dir, "out-"));
});
const client = () => new Jira({ baseUrl: jiraUrl, email: "bot@client.example", apiToken: "jira-token" });

// ---------------------------------------------------------------- the client

test("a ticket is read with its status, labels and label history", async () => {
  jira.histories = [labelled(STRANGER, "2026-11-15T09:00:00.000+0000"), { created: "2026-11-15T10:00:00.000+0000", author: STRANGER, items: [{ field: "labels", fromString: "factory", toString: "" }] }, labelled(APPROVER)];
  const issue = await client().getIssue("OLV-42");
  assert.equal(issue.status, "Defined");
  assert.deepEqual(issue.labels, ["factory"]);
  assert.equal(issue.url, `${jiraUrl}/browse/OLV-42`);
  assert.equal(issue.labelChanges.length, 3);
  // The most recent person to add the label is the one who counts.
  assert.deepEqual(labelAddedBy(issue, "factory"), { accountId: "acc-ada", email: "ada@client.example", name: "Ada" });
  assert.equal(labelAddedBy(issue, "other"), null);
});

test("approvers can be listed by account id or by email address", () => {
  const ada = { accountId: "acc-ada", email: "ada@client.example", name: "Ada" };
  assert.ok(isJiraApprover(ada, ["acc-ada"]));
  assert.ok(isJiraApprover(ada, ["ADA@client.example"]));
  assert.ok(!isJiraApprover(ada, ["acc-eve", "eve@client.example"]));
  // Jira can hide email addresses; an account id still matches.
  assert.ok(isJiraApprover({ accountId: "acc-ada", email: null, name: "Ada" }, ["acc-ada"]));
  assert.ok(!isJiraApprover({ accountId: "", email: null, name: "" }, [""]));
});

test("a ticket is moved by the status it should end in, whatever the transition is called", async () => {
  const c = client();
  assert.equal(await c.moveTo("OLV-42", "In Progress", "Defined"), "moved");
  assert.equal(jira.issue.status, "In Progress");
  assert.equal(await c.moveTo("OLV-42", "in progress", "In Progress"), "already");
  // From Testing, the way back to In Progress is a transition named "Refactoring Work".
  jira.issue.status = "Testing";
  assert.equal(await c.moveTo("OLV-42", "In Progress", "Testing"), "moved");
  assert.equal(jira.issue.status, "In Progress");
  // The workflow has no move from Done to In Progress.
  jira.issue.status = "Done";
  assert.equal(await c.moveTo("OLV-42", "In Progress", "Done"), "unavailable");
  assert.equal(jira.issue.status, "Done");
});

test("Jira failures carry the status and message, and bad input is refused before any call", async () => {
  await assert.rejects(new Jira({ baseUrl: jiraUrl, email: "bot@client.example", apiToken: "wrong" }).getIssue("OLV-42"), (e: unknown) => e instanceof JiraError && e.status === 401);
  await assert.rejects(client().getIssue("OLV-99"), (e: unknown) => e instanceof JiraError && e.status === 404 && /does not exist/.test(e.message));
  await assert.rejects(client().getIssue("../etc"), TypeError);
  assert.throws(() => new Jira({ baseUrl: "http://example.atlassian.net", email: "a", apiToken: "b" }), /https/);
  assert.throws(() => new Jira({ baseUrl: "https://example.atlassian.net", email: "", apiToken: "b" }), /required/);
});

test("the jira section of repository policy is validated", () => {
  const base = { version: 1, baseBranch: "main", approvers: ["owner"], commands: { setup: [], test: [["node", "--test"]] } };
  const good = { baseUrl: "https://client.atlassian.net/", statuses: { inProgress: "In Progress", review: "Testing" }, approvers: ["acc-ada"] };
  const c = parseConfig(JSON.stringify({ ...base, jira: good }));
  assert.deepEqual(c.jira, { baseUrl: "https://client.atlassian.net", label: "factory", statuses: { inProgress: "In Progress", review: "Testing" }, approvers: ["acc-ada"] });
  assert.equal(parseConfig(JSON.stringify(base)).jira, undefined);
  assert.equal(parseConfig(JSON.stringify({ ...base, jira: { ...good, statuses: { inProgress: "Doing" } } })).jira?.statuses.review, undefined);
  const bad = (j: unknown) => () => parseConfig(JSON.stringify({ ...base, jira: j }));
  assert.throws(bad({ ...good, baseUrl: "http://client.atlassian.net" }), /https/);
  assert.throws(bad({ ...good, statuses: {} }), /inProgress/);
  assert.throws(bad({ ...good, approvers: [] }), /jira.approvers/);
  assert.throws(bad({ ...good, label: "has space" }), /jira.label/);
});

// ---------------------------------------------------------------- the admit step, for a Jira ticket

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const repo = join(dir, "repo");
mkdirSync(join(repo, ".factory"), { recursive: true });
writeFileSync(
  join(repo, ".factory/config.json"),
  JSON.stringify({
    version: 1, baseBranch: "main", approvers: ["owner"], commands: { setup: [], test: [["node", "--test"]] },
    jira: { baseUrl: "https://client.atlassian.net", statuses: { inProgress: "In Progress", review: "Testing" }, approvers: ["acc-ada"] },
  }),
);
for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "base"]]) spawnSync("git", args, { cwd: repo, env: gitEnv });
const fakeClaude = join(dir, "claude.mjs");
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
import { readFileSync } from "node:fs";
for await (const _ of process.stdin) {}
console.log(JSON.stringify({ is_error: false, total_cost_usd: 0.02, modelUsage: { "claude-sonnet-5-5": {} }, structured_output: JSON.parse(readFileSync(${JSON.stringify(scoreFile)}, "utf8")) }));
`,
);
chmodSync(fakeClaude, 0o755);

function admit(env: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, "src/cli.ts"), "admit"], {
      env: {
        ...process.env,
        GITHUB_API_URL: githubUrl, GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/app", GITHUB_REF: "refs/heads/main",
        GITHUB_WORKFLOW_REF: "acme/app/.github/workflows/factory.yml@refs/heads/main",
        GITHUB_OUTPUT: join(outDir, "gh-output"), GITHUB_STEP_SUMMARY: "",
        FACTORY_REPO_DIR: repo, FACTORY_ISSUE: "", FACTORY_JIRA: "OLV-42", FACTORY_JIRA_URL: jiraUrl,
        JIRA_EMAIL: "bot@client.example", JIRA_API_TOKEN: "jira-token",
        FACTORY_ACTOR: "owner", FACTORY_DEFAULT_BRANCH: "main",
        FACTORY_RUN_URL: "https://example.invalid/run/1", FACTORY_APP_LOGIN: BOT, FACTORY_OUT: outDir,
        FACTORY_CLAUDE: fakeClaude, CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "",
        ...env,
      },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.resume();
    child.on("close", (status) => resolve({ status, stderr }));
  });
}
const jiraComments = () => jira.comments.map((c) => adfText({ type: "x", content: c.content!.flatMap((n) => [n, { type: "hardBreak" }]) }));

test("a labelled Jira ticket that passes is picked up: moved to In Progress, mirrored on GitHub, and admitted", async () => {
  const r = await admit();
  assert.equal(r.status, 0, r.stderr);
  // The ticket moved, by the status it should end in.
  assert.equal(jira.issue.status, "In Progress");
  assert.ok(jira.issue.labels.includes("factory"));
  assert.equal(jira.comments.length, 1);
  assert.ok(jiraComments()[0]!.includes("The factory has started work on this ticket."));
  assert.ok(jiraComments()[0]!.includes("Average 5, lowest 5."));
  // A GitHub issue now holds the run's history, with the same task.
  assert.equal(github.issues.length, 1);
  const mirror = github.issues[0]!;
  assert.ok(mirror.title.startsWith("[OLV-42] "));
  assert.deepEqual(mirror.labels, ["factory:jira"]);
  assert.ok(mirror.body.includes(`${jiraUrl}/browse/OLV-42`));
  assert.deepEqual(extractTask(mirror.body), { ok: true, task: fullTask() });
  const events = (github.comments.get(mirror.number) ?? []).filter((c) => c.body.startsWith(EVENT_MARKER));
  assert.equal(events.length, 4);
  assert.ok(events[0]!.body.includes("Jira ticket OLV-42"));
  assert.ok(github.labels.get(mirror.number)!.has("factory:in-progress"));
  // The rest of the pipeline is told which issue to use.
  assert.ok(readFileSync(join(outDir, "gh-output"), "utf8").includes(`issue=${mirror.number}\n`));
  const admitted = JSON.parse(readFileSync(join(outDir, "task.json"), "utf8"));
  assert.deepEqual(admitted.jira, { key: "OLV-42", url: `${jiraUrl}/browse/OLV-42` });
  assert.equal(admitted.issue, mirror.number);
});

test("it is picked up from whatever status it is in, and says so when the workflow cannot move it", async () => {
  jira.issue.status = "Testing";
  assert.equal((await admit()).status, 0);
  assert.equal(jira.issue.status, "In Progress");

  // A different ticket's run: start the stand-in GitHub afresh so the new mirror issue has no history.
  github.issues = [];
  github.comments = new Map();
  github.labels = new Map();
  jira.comments = [];
  jira.issue.status = "Done";
  assert.equal((await admit()).status, 0);
  assert.equal(jira.issue.status, "Done");
  assert.ok(jiraComments()[0]!.includes('It could not move the ticket to "In Progress": the workflow has no such move from "Done".'));
});

test("a Jira ticket under the bar is refused in Jira: label removed, scores posted, nothing created on GitHub", async () => {
  writeFileSync(scoreFile, JSON.stringify(scores(5, { testCases: 3 })));
  const r = await admit();
  assert.equal(r.status, 1);
  assert.ok(!jira.issue.labels.includes("factory"));
  assert.equal(jira.issue.status, "Defined");
  assert.equal(github.issues.length, 0);
  assert.equal(jira.comments.length, 1);
  assert.ok(jiraComments()[0]!.includes("the ticket evaluation did not pass"));
  assert.ok(jiraComments()[0]!.includes("Test cases: 3: "));
  assert.ok(!existsSync(join(outDir, "task.json")));
});

test("a label added by someone who is not a Jira approver starts nothing", async () => {
  jira.histories = [labelled(STRANGER)];
  const r = await admit();
  assert.equal(r.status, 1);
  assert.ok(!jira.issue.labels.includes("factory"));
  assert.ok(jiraComments()[0]!.includes("Eve is not listed under jira.approvers"));
  assert.equal(github.issues.length, 0);
});

test("who added the label is taken from Jira's history, so a missing history is refused", async () => {
  jira.histories = [];
  const r = await admit();
  assert.equal(r.status, 1);
  assert.ok(jiraComments()[0]!.includes("does not show who added the 'factory' label"));
});

test("a Jira ticket without a task, or already run, is refused with the reason", async () => {
  jira.issue.description = doc(p("Make signup better."));
  assert.equal((await admit()).status, 1);
  assert.ok(jiraComments()[0]!.includes("does not contain a valid task"));

  jira.issue = { key: "OLV-42", status: "Defined", labels: ["factory"], description: ticketBody(fullTask()), summary: "x" };
  jira.comments = [];
  github.issues = [{ number: 77, title: "[OLV-42] Earlier run", body: "", labels: ["factory:jira"] }];
  assert.equal((await admit()).status, 1);
  assert.ok(jiraComments()[0]!.includes("already has a factory run, recorded in GitHub issue #77"));
  assert.equal(github.issues.length, 1);
});

test("the account that called GitHub must be an approver too, and Jira credentials must be present", async () => {
  const stranger = await admit({ FACTORY_ACTOR: "someone" });
  assert.equal(stranger.status, 1);
  assert.ok(jiraComments()[0]!.includes("(someone) is not listed as an approver"));
  assert.equal(github.issues.length, 0);

  const noCreds = await admit({ JIRA_EMAIL: "", JIRA_API_TOKEN: "" });
  assert.equal(noCreds.status, 1);
  assert.match(noCreds.stderr, /JIRA_EMAIL and JIRA_API_TOKEN are not available/);

  const badKey = await admit({ FACTORY_JIRA: "not a key" });
  assert.equal(badKey.status, 1);
  assert.match(badKey.stderr, /not a Jira ticket key/);
});

test("the factory signs in to Jira as its own account on every call", async () => {
  await admit();
  assert.ok(jira.auth.length >= 3);
  assert.ok(jira.auth.every((a) => a === `Basic ${Buffer.from("bot@client.example:jira-token").toString("base64")}`));
});
