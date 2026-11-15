import assert from "node:assert/strict";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { GitHubLedger, encodeEvent } from "../src/control/github-ledger.ts";
import { advance, loadRun } from "../src/control/ledger.ts";
import { GitHub, GitHubApiError } from "../src/github/rest.ts";
import { ensurePullRequest, taskMarker } from "../src/publisher/publish.ts";
import { ev } from "./helpers.ts";

/** A tiny in-memory stand-in for the parts of the GitHub API the client uses. */
const state = {
  comments: [] as { id: number; issue: number; body: string; user: { login: string } }[],
  pulls: [] as { number: number; draft: boolean; body: string; title: string; head: { ref: string; repo: { full_name: string } }; base: { ref: string } }[],
  nextId: 1000,
  seen: [] as { method: string; url: string; auth: string | undefined }[],
};
const APP = "factory-app[bot]";
const REPO = "/repos/acme/app";

function handle(req: IncomingMessage, res: ServerResponse, body: string) {
  const url = new URL(req.url!, "http://x");
  state.seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
  const send = (status: number, json?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(json === undefined ? undefined : JSON.stringify(json));
  };
  if (req.headers.authorization !== "Bearer t0ken") return send(401, { message: "Bad credentials" });
  const path = url.pathname.slice(REPO.length);
  const page = Number(url.searchParams.get("page") ?? 1);
  const per = Number(url.searchParams.get("per_page") ?? 30);
  const slice = <T>(all: T[]) => all.slice((page - 1) * per, page * per);
  let m: RegExpExecArray | null;

  if ((m = /^\/issues\/(\d+)\/comments$/.exec(path))) {
    const issue = Number(m[1]);
    if (req.method === "GET") return send(200, slice(state.comments.filter((c) => c.issue === issue)));
    const c = { id: state.nextId++, issue, body: JSON.parse(body).body, user: { login: APP } };
    state.comments.push(c);
    return send(201, c);
  }
  if ((m = /^\/issues\/comments\/(\d+)$/.exec(path)) && req.method === "DELETE") {
    state.comments = state.comments.filter((c) => c.id !== Number(m![1]));
    return send(204);
  }
  if ((m = /^\/issues\/(\d+)$/.exec(path))) {
    return m[1] === "7"
      ? send(200, { number: 7, state: "open", body: null, user: { login: "owner" } })
      : send(404, { message: "Not Found" });
  }
  if (path === "/pulls" && req.method === "GET") {
    const head = url.searchParams.get("head");
    return send(200, slice(state.pulls.filter((p) => `acme:${p.head.ref}` === head)));
  }
  if (path === "/pulls" && req.method === "POST") {
    const b = JSON.parse(body);
    const p = { number: state.pulls.length + 1, draft: b.draft, body: b.body, title: b.title, head: { ref: b.head, repo: { full_name: "acme/app" } }, base: { ref: b.base } };
    state.pulls.push(p);
    return send(201, p);
  }
  if ((m = /^\/pulls\/(\d+)$/.exec(path)) && req.method === "PATCH") {
    const p = state.pulls.find((x) => x.number === Number(m![1]))!;
    Object.assign(p, JSON.parse(body));
    return send(200, p);
  }
  send(404, { message: "Not Found" });
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => handle(req, res, body));
});
let gh: GitHub;
let apiUrl: string;
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  gh = new GitHub({ token: "t0ken", repo: "acme/app", apiUrl });
});
after(() => server.close());

test("issues are read, with an empty body normalised", async () => {
  assert.deepEqual(await gh.getIssue(7), { number: 7, author: "owner", state: "open", body: "", isPullRequest: false });
});

test("API failures carry the status and message", async () => {
  await assert.rejects(gh.getIssue(8), (e: unknown) => e instanceof GitHubApiError && e.status === 404 && /Not Found/.test(e.message));
  const bad = new GitHub({ token: "wrong", repo: "acme/app", apiUrl });
  await assert.rejects(bad.getIssue(7), (e: unknown) => e instanceof GitHubApiError && e.status === 401);
});

test("comment listing follows pagination and returns oldest first", async () => {
  for (let i = 0; i < 205; i++) state.comments.push({ id: 1 + i, issue: 3, body: `c${i}`, user: { login: "someone" } });
  const list = await gh.list(3);
  assert.equal(list.length, 205);
  assert.equal(list[0]?.body, "c0");
  assert.equal(list[204]?.body, "c204");
  assert.equal(state.seen.filter((s) => s.url.includes("/issues/3/comments")).length, 3);
});

test("a run can be driven through the client as the ledger's backend", async () => {
  state.comments.push({ id: state.nextId++, issue: 12, body: encodeEvent(1, ev("cancel-authorized")), user: { login: "intruder" } });
  const ledger = new GitHubLedger(gh, APP);
  await advance(ledger, "12", ev("approval-verified"));
  await advance(ledger, "12", ev("admitted"));
  const run = await loadRun(ledger, "12");
  assert.equal(run.state, "queued");
  assert.equal(state.comments.filter((c) => c.issue === 12 && c.user.login === APP).length, 2);
});

test("comments can be deleted", async () => {
  const c = await gh.create(40, "temporary");
  assert.equal((await gh.list(40)).length, 1);
  await gh.delete(c.id);
  assert.deepEqual(await gh.list(40), []);
});

test("the publisher's pull request step works through the client", async () => {
  const request = { taskId: "42", base: "main", title: "Add truncate", body: "v1" };
  assert.deepEqual(await ensurePullRequest(gh, request), { number: 1, created: true });
  assert.equal(state.pulls[0]?.draft, true);
  assert.deepEqual(await ensurePullRequest(gh, { ...request, body: "v2" }), { number: 1, created: false });
  assert.equal(state.pulls.length, 1);
  assert.equal(state.pulls[0]?.body, `${taskMarker("42")}\nv2`);
});

test("a same-named branch in a fork is not mistaken for the factory branch", async () => {
  state.pulls.push({ number: 99, draft: false, body: "", title: "", head: { ref: "factory/50", repo: { full_name: "acme/app" } }, base: { ref: "main" } });
  state.pulls.push({ number: 98, draft: false, body: "", title: "", head: { ref: "factory/50", repo: { full_name: "fork/app" } }, base: { ref: "main" } });
  assert.deepEqual((await gh.listOpenByHead("factory/50")).map((p) => p.number), [99]);
});

test("the client refuses malformed configuration", () => {
  assert.throws(() => new GitHub({ token: "t", repo: "not a repo" }), TypeError);
  assert.throws(() => new GitHub({ token: "", repo: "acme/app" }), TypeError);
});
