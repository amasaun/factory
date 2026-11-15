import assert from "node:assert/strict";
import { test } from "node:test";
import { LedgerConflictError, MemoryLedger, advance, loadRun } from "../src/control/ledger.ts";
import { replay } from "../src/control/run.ts";
import { TransitionError } from "../src/control/states.ts";
import { ev, toReady } from "./helpers.ts";

test("state rebuilt from the log equals state reached step by step", async () => {
  const ledger = new MemoryLedger();
  let last;
  for (const e of toReady()) last = await advance(ledger, "7", e);
  assert.deepEqual(await loadRun(ledger, "7"), last);
  assert.deepEqual(replay("7", await ledger.read("7")), last);
});

test("a rejected event writes nothing", async () => {
  const ledger = new MemoryLedger();
  await advance(ledger, "7", ev("approval-verified"));
  await assert.rejects(advance(ledger, "7", ev("published")), Error);
  await assert.rejects(advance(ledger, "7", ev("capacity-granted")), TransitionError);
  assert.equal((await ledger.read("7")).length, 1);
});

test("two writers cannot both advance the same run", async () => {
  const ledger = new MemoryLedger();
  await ledger.append("7", 0, ev("approval-verified"));
  await ledger.append("7", 1, ev("admitted"));
  await assert.rejects(ledger.append("7", 1, ev("dependency-unmet")), LedgerConflictError);
  assert.equal((await loadRun(ledger, "7")).state, "queued");
});

test("runs are independent of each other", async () => {
  const ledger = new MemoryLedger();
  await advance(ledger, "7", ev("approval-verified"));
  assert.equal((await loadRun(ledger, "8")).state, "draft");
});
