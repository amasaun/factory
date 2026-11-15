import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetError } from "../src/control/budget.ts";
import { StaleEvidenceError, StaleLeaseError, allowedTriggers, applyEvent, newRun } from "../src/control/run.ts";
import { ACTIVE, STATES, TERMINAL, TRANSITIONS, TRIGGERS, TransitionError } from "../src/control/states.ts";
import { C1, C2, C3, ev, run, toReady, toVerifying, verifyingToReady } from "./helpers.ts";

test("a correct task travels from draft to merged", () => {
  const r = run([...toReady(), ev("pr-merged")]);
  assert.equal(r.state, "merged");
  assert.equal(r.candidate, C1);
  assert.deepEqual(
    r.history.filter((h) => h.from !== h.to).map((h) => h.to),
    [
      "approved", "queued", "provisioning", "baseline", "building", "candidate-frozen",
      "verifying", "judging", "publishing", "ci-pending", "ready", "merged",
    ],
  );
  assert.equal(r.seq, r.history.length);
});

test("every state is reachable or initial, and every rule names real states", () => {
  const destinations = new Set<string>(["draft"]);
  for (const t of TRIGGERS) {
    const rule = TRANSITIONS[t];
    for (const s of rule.from) assert.ok(STATES.includes(s));
    if (rule.to !== "named") destinations.add(rule.to);
  }
  for (const s of STATES) assert.ok(destinations.has(s), `${s} is unreachable`);
});

test("terminal states accept nothing", () => {
  const merged = run([...toReady(), ev("pr-merged")]);
  assert.deepEqual(allowedTriggers(merged), []);
  for (const t of TRIGGERS) {
    assert.throws(() => applyEvent(merged, ev(t, { candidate: C1, lease: 1 })), TransitionError);
  }
  for (const s of TERMINAL) assert.ok(!ACTIVE.includes(s));
});

test("transitions outside the table are rejected", () => {
  assert.throws(() => run([ev("admitted")]), TransitionError);
  assert.throws(() => run([ev("approval-verified"), ev("published", { candidate: C1 })]), StaleEvidenceError);
  // Publishing cannot be reached without a judge acceptance.
  assert.throws(() => run([...toVerifying(), ev("published", { candidate: C1 })]), TransitionError);
});

test("an event without a cause is rejected", () => {
  assert.throws(() => applyEvent(newRun("1"), { type: "approval-verified", cause: " " }), TransitionError);
});

test("results from a superseded worker lease are rejected", () => {
  const replaced = run([...toVerifying(), ev("lease-issued")]);
  assert.equal(replaced.leaseGeneration, 2);
  assert.throws(() => applyEvent(replaced, ev("verification-passed", { lease: 1, candidate: C1 })), StaleLeaseError);
  assert.throws(() => applyEvent(replaced, ev("verification-passed", { candidate: C1 })), StaleLeaseError);
  assert.equal(applyEvent(replaced, ev("verification-passed", { lease: 2, candidate: C1 })).state, "judging");
});

test("evidence for a different candidate is rejected", () => {
  const verifying = run(toVerifying());
  assert.throws(() => applyEvent(verifying, ev("verification-passed", { lease: 1, candidate: C2 })), StaleEvidenceError);

  // After a repair, a late CI or judge result for the old candidate cannot count.
  const repaired = run([
    ...toVerifying(),
    ev("actionable-failure", { lease: 1, candidate: C1 }),
    ev("builder-invoked", { lease: 1, phase: "repair" }),
    ev("candidate-bundled", { lease: 1, candidate: C2 }),
    ev("verifier-provisioned", { candidate: C2 }),
    ev("verification-passed", { lease: 1, candidate: C2 }),
    ev("judge-invoked", { lease: 1, phase: "initial" }),
  ]);
  assert.throws(() => applyEvent(repaired, ev("judge-accepted", { lease: 1, candidate: C1 })), StaleEvidenceError);
  assert.equal(applyEvent(repaired, ev("judge-accepted", { lease: 1, candidate: C2 })).state, "publishing");
});

test("a repair must produce a new candidate", () => {
  const repairing = run([
    ...toVerifying(),
    ev("actionable-failure", { lease: 1, candidate: C1 }),
    ev("builder-invoked", { lease: 1, phase: "repair" }),
  ]);
  assert.throws(() => applyEvent(repairing, ev("candidate-bundled", { lease: 1, candidate: C1 })), TransitionError);
});

test("repair rounds stop at the limit and the run escalates", () => {
  const candidates = [C1, C2, C3];
  let r = run(toVerifying());
  for (let round = 0; round < 2; round++) {
    r = run(
      [
        ev("actionable-failure", { lease: 1, candidate: candidates[round] }),
        ev("builder-invoked", { lease: 1, phase: "repair" }),
        ev("candidate-bundled", { lease: 1, candidate: candidates[round + 1] }),
        ev("verifier-provisioned", { candidate: candidates[round + 1] }),
      ],
      r,
    );
  }
  assert.throws(() => applyEvent(r, ev("actionable-failure", { lease: 1, candidate: C3 })), BudgetError);
  const escalated = applyEvent(r, ev("budget-exhausted", { resumeTargets: ["repairing"] }));
  assert.equal(escalated.state, "needs-human");
});

test("a failed CI run gets exactly one repair cycle", () => {
  const ciPending = run([...toVerifying(), ...verifyingToReady().slice(0, 4)]);
  assert.equal(ciPending.state, "ci-pending");
  let r = run(
    [
      ev("actionable-failure", { candidate: C1 }),
      ev("builder-invoked", { lease: 1, phase: "ci" }),
      ev("candidate-bundled", { lease: 1, candidate: C2 }),
      ev("verifier-provisioned", { candidate: C2 }),
      ev("verification-passed", { lease: 1, candidate: C2 }),
      ev("judge-invoked", { lease: 1, phase: "ci" }),
      ev("judge-accepted", { lease: 1, candidate: C2 }),
      ev("published", { candidate: C2 }),
    ],
    ciPending,
  );
  assert.equal(r.state, "ci-pending");
  assert.throws(() => applyEvent(r, ev("actionable-failure", { candidate: C2 })), BudgetError);
});

test("entering needs-human requires resume targets, and a decision must pick one", () => {
  const baseline = run(toVerifying().slice(0, 5));
  assert.equal(baseline.state, "baseline");
  assert.throws(() => applyEvent(baseline, ev("baseline-unclassified", { lease: 1 })), TransitionError);
  assert.throws(
    () => applyEvent(baseline, ev("baseline-unclassified", { lease: 1, resumeTargets: ["merged"] })),
    TransitionError,
  );
  const waiting = applyEvent(baseline, ev("baseline-unclassified", { lease: 1, resumeTargets: ["building"] }));
  assert.throws(() => applyEvent(waiting, ev("human-decision", { target: "publishing" })), TransitionError);
  assert.throws(() => applyEvent(waiting, ev("human-decision")), TransitionError);
  const resumed = applyEvent(waiting, ev("human-decision", { target: "building" }));
  assert.equal(resumed.state, "building");
  assert.deepEqual(resumed.resumeTargets, []);
  assert.equal(applyEvent(waiting, ev("decision-timeout")).state, "cancelled");
});

test("closing the pull request cancels only when a pull request exists", () => {
  assert.throws(() => run([...toVerifying(), ev("pr-closed")]), TransitionError);
  assert.equal(run([...toReady(), ev("pr-closed")]).state, "cancelled");
});

test("a foreign commit hands the branch off; only adopt resumes it", () => {
  assert.throws(() => run([ev("approval-verified"), ev("foreign-commit")]), TransitionError);
  const handed = run([...toReady(), ev("foreign-commit")]);
  assert.equal(handed.state, "handed-off");
  assert.deepEqual(allowedTriggers(handed), ["adopt"]);
  assert.throws(() => applyEvent(handed, ev("cancel-authorized")), TransitionError);
  const adopted = applyEvent(handed, ev("adopt", { candidate: C2 }));
  assert.equal(adopted.state, "candidate-frozen");
  assert.equal(adopted.candidate, C2);
});

test("review feedback grants one builder and one judge call per round, up to the limit", () => {
  let r = run(toReady());
  const candidates = [C1, C2, C3, "4".repeat(40), "5".repeat(40)];
  for (let round = 1; round <= 3; round++) {
    const next = candidates[round]!;
    r = run(
      [
        ev("changes-requested"),
        ev("feedback-in-scope"),
        ev("builder-invoked", { lease: 1, phase: "feedback" }),
        ev("candidate-bundled", { lease: 1, candidate: next }),
        ev("verifier-provisioned", { candidate: next }),
        ev("verification-passed", { lease: 1, candidate: next }),
        ev("judge-invoked", { lease: 1, phase: "feedback" }),
        ev("judge-accepted", { lease: 1, candidate: next }),
        ev("published", { candidate: next }),
        ev("ci-passed", { candidate: next }),
      ],
      r,
    );
    assert.equal(r.usage.feedbackRoundsGranted, round);
  }
  const fourth = applyEvent(r, ev("changes-requested"));
  assert.throws(() => applyEvent(fourth, ev("feedback-in-scope")), BudgetError);
  assert.equal(
    applyEvent(fourth, ev("feedback-out-of-scope", { resumeTargets: ["repairing"] })).state,
    "needs-human",
  );
});

test("a feedback builder call without a granted round is refused", () => {
  const repairing = run([...toVerifying(), ev("actionable-failure", { lease: 1, candidate: C1 })]);
  assert.throws(() => applyEvent(repairing, ev("builder-invoked", { lease: 1, phase: "feedback" })), BudgetError);
});

test("carry-forward keeps the run ready on a new commit without spending budget", () => {
  const ready = run(toReady());
  const carried = applyEvent(ready, ev("carried-forward", { candidate: C2 }));
  assert.equal(carried.state, "ready");
  assert.equal(carried.candidate, C2);
  assert.deepEqual(carried.usage, ready.usage);
  assert.throws(() => applyEvent(ready, ev("carried-forward", { candidate: C1 })), TransitionError);
});

test("a stale run can refresh once from the reserve", () => {
  const stale = run([...toReady(), ev("base-moved-stale")]);
  const refreshed = run(
    [
      ev("builder-invoked", { lease: 1, phase: "refresh" }),
      ev("judge-invoked", { lease: 1, phase: "refresh" }),
      ev("refresh-succeeded", { candidate: C2 }),
    ],
    stale,
  );
  assert.equal(refreshed.state, "ready");
  const staleAgain = applyEvent(refreshed, ev("base-moved-stale"));
  assert.throws(() => applyEvent(staleAgain, ev("builder-invoked", { lease: 1, phase: "refresh" })), BudgetError);
});

test("builder and judge calls are only accepted in the matching state", () => {
  const verifying = run(toVerifying());
  assert.throws(() => applyEvent(verifying, ev("builder-invoked", { lease: 1, phase: "initial" })), TransitionError);
  assert.throws(() => applyEvent(verifying, ev("judge-invoked", { lease: 1, phase: "initial" })), TransitionError);
});

test("infrastructure retries are capped", () => {
  let r = run([ev("approval-verified"), ev("admitted"), ev("capacity-granted")]);
  r = run([ev("infra-retry"), ev("infra-retry"), ev("infra-retry")], r);
  assert.throws(() => applyEvent(r, ev("infra-retry")), BudgetError);
  assert.equal(applyEvent(r, ev("infra-exhausted", { resumeTargets: ["provisioning"] })).state, "needs-human");
});
