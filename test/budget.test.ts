import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Phase,
  BudgetError,
  DEFAULT_LIMITS,
  consume,
  emptyUsage,
  limitProblems,
} from "../src/control/budget.ts";

test("the default limits are coherent: totals equal the phase allowances", () => {
  assert.deepEqual(limitProblems(DEFAULT_LIMITS), []);
});

test("a full run that uses every phase fits inside the totals", () => {
  const builder: Phase[] = ["initial", "initial", "initial", "repair", "repair", "ci", "refresh"];
  const judge: Phase[] = ["initial", "repair", "repair", "ci", "refresh"];
  let usage = emptyUsage();
  for (const p of builder) usage = consume(DEFAULT_LIMITS, usage, "builder", p);
  for (const p of judge) usage = consume(DEFAULT_LIMITS, usage, "judge", p);
  assert.throws(() => consume(DEFAULT_LIMITS, usage, "builder", "initial"), BudgetError);
  assert.throws(() => consume(DEFAULT_LIMITS, usage, "judge", "refresh"), BudgetError);
});

test("totals that strand a required phase are reported", () => {
  // The v0.1 numbers: three judge calls could not cover a refresh re-judgment.
  const problems = limitProblems({ ...DEFAULT_LIMITS, totalJudge: 3 });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /totalJudge/);
});

test("the total cap applies even when a phase has room", () => {
  const limits = { ...DEFAULT_LIMITS, totalBuilder: 2 };
  let usage = consume(limits, emptyUsage(), "builder", "initial");
  usage = consume(limits, usage, "builder", "initial");
  assert.throws(() => consume(limits, usage, "builder", "initial"), /total limit/);
});

test("negative or fractional limits are reported", () => {
  assert.ok(limitProblems({ ...DEFAULT_LIMITS, repairRounds: -1 }).some((p) => p.includes("repairRounds")));
  assert.ok(limitProblems({ ...DEFAULT_LIMITS, activeMinutes: 1.5 }).some((p) => p.includes("activeMinutes")));
});
