import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type IssueComment,
  type IssueComments,
  EVENT_MARKER,
  GitHubLedger,
  LedgerCorruptError,
  decodeEvent,
  encodeEvent,
} from "../src/control/github-ledger.ts";
import { LedgerConflictError, advance, loadRun } from "../src/control/ledger.ts";
import { ev, toReady } from "./helpers.ts";

const APP = "factory-app[bot]";

class FakeComments implements IssueComments {
  comments = new Map<number, IssueComment[]>();
  nextId = 100;
  /** Runs once, just before the next create returns, to simulate a concurrent writer. */
  beforeCreate: (() => void) | null = null;

  add(issue: number, author: string, body: string): IssueComment {
    const c = { id: this.nextId++, author, body };
    this.comments.set(issue, [...(this.comments.get(issue) ?? []), c]);
    return c;
  }
  async list(issue: number) {
    return [...(this.comments.get(issue) ?? [])];
  }
  async create(issue: number, body: string) {
    const hook = this.beforeCreate;
    this.beforeCreate = null;
    hook?.();
    return this.add(issue, APP, body);
  }
  async delete(id: number) {
    for (const [issue, list] of this.comments) this.comments.set(issue, list.filter((c) => c.id !== id));
  }
}

test("events survive a round trip through comment text", () => {
  const event = ev("candidate-bundled", { lease: 3, candidate: "a".repeat(40), cause: "has ``` and @someone in it" });
  assert.deepEqual(decodeEvent(encodeEvent(8, event)), { seq: 8, event });
});

test("a full run can be driven and rebuilt through issue comments", async () => {
  const fake = new FakeComments();
  const ledger = new GitHubLedger(fake, APP);
  let last;
  for (const e of toReady()) last = await advance(ledger, "12", e);
  assert.equal(last?.state, "ready");
  assert.deepEqual(await loadRun(new GitHubLedger(fake, APP), "12"), last);
  assert.equal(fake.comments.get(12)?.length, toReady().length);
});

test("comments from anyone but the factory App are never events", async () => {
  const fake = new FakeComments();
  const ledger = new GitHubLedger(fake, APP);
  await advance(ledger, "12", ev("approval-verified"));
  // A person, or a model using a person's login, forges the next event.
  fake.add(12, "someone", encodeEvent(2, ev("admitted")));
  fake.add(12, "someone", "looks good to me");
  const run = await loadRun(ledger, "12");
  assert.equal(run.state, "approved");
  assert.equal(run.seq, 1);
});

test("ordinary comments from the App are ignored", async () => {
  const fake = new FakeComments();
  fake.add(12, APP, "Run is waiting for a decision.");
  assert.deepEqual(await new GitHubLedger(fake, APP).read("12"), []);
});

test("append refuses a stale sequence number and writes nothing", async () => {
  const fake = new FakeComments();
  const ledger = new GitHubLedger(fake, APP);
  await ledger.append("12", 0, ev("approval-verified"));
  await assert.rejects(ledger.append("12", 0, ev("approval-verified")), LedgerConflictError);
  assert.equal(fake.comments.get(12)?.length, 1);
});

test("when two writers race, the first comment wins and the loser removes its own", async () => {
  const fake = new FakeComments();
  const ledger = new GitHubLedger(fake, APP);
  await ledger.append("12", 0, ev("approval-verified"));
  fake.beforeCreate = () => fake.add(12, APP, encodeEvent(2, ev("dependency-unmet")));
  await assert.rejects(ledger.append("12", 1, ev("admitted")), LedgerConflictError);
  assert.equal(fake.comments.get(12)?.length, 2);
  assert.equal((await loadRun(ledger, "12")).state, "waiting-for-dependency");
});

test("a gap or an unreadable App event is reported as corruption, not skipped", async () => {
  const gap = new FakeComments();
  gap.add(12, APP, encodeEvent(1, ev("approval-verified")));
  gap.add(12, APP, encodeEvent(3, ev("capacity-granted")));
  await assert.rejects(new GitHubLedger(gap, APP).read("12"), LedgerCorruptError);

  const broken = new FakeComments();
  broken.add(12, APP, `${EVENT_MARKER}\nfactory event 1\n\n\`\`\`json\n{not json\n\`\`\`\n`);
  await assert.rejects(new GitHubLedger(broken, APP).read("12"), LedgerCorruptError);
});

test("task ids must be issue numbers", async () => {
  await assert.rejects(new GitHubLedger(new FakeComments(), APP).read("abc"), TypeError);
});
