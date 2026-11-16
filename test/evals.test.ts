import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type TicketCase, caseProblems, estimate, judgeTrial, loadCases, renderReport, runTickets, summarise } from "../src/evals/tickets.ts";
import { AREAS, type Area, evaluateTicket, failsWithoutModel } from "../src/run/evaluate.ts";
import { fullTask, scores } from "./helpers.ts";

const root = new URL("..", import.meta.url).pathname;
const T = { minMean: 4.5, minArea: 4 };
const cases = loadCases(join(root, "evals/tickets"));
const good = (): TicketCase => ({ id: "good", why: "A complete ticket that should pass.", repository: "acme/app", task: fullTask(), expect: { outcome: "pass" } });
const bad = (weakAreas: Area[]): TicketCase => ({ ...good(), id: "bad", expect: { outcome: "fail", weakAreas } });

test("every golden ticket is well formed and labelled", () => {
  assert.ok(cases.length >= 15);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  for (const outcome of ["pass", "fail", "borderline"]) {
    assert.ok(cases.some((c) => c.expect.outcome === outcome), `no ${outcome} case`);
  }
  // Every scored area is the labelled weakness of at least one case, so no area goes untested.
  const covered = new Set(cases.flatMap((c) => c.expect.weakAreas ?? []));
  for (const area of AREAS) assert.ok(covered.has(area), `no case targets ${area}`);
});

test("cases meant for plain checks are decided without a model, and the others are not", () => {
  for (const c of cases) {
    const plain = failsWithoutModel(c.task, c.repository);
    assert.equal(plain, c.id.startsWith("plain-"), c.id);
    if (!plain) continue;
    // With no model at all, the plain checks alone must refuse it for the labelled reason.
    assert.equal(judgeTrial(c, evaluateTicket(c.task, c.repository, null, T)), "correct", c.id);
  }
});

test("a malformed case is rejected with reasons", () => {
  assert.deepEqual(caseProblems(good()), []);
  assert.ok(caseProblems({ ...good(), id: "Bad Id" }).some((p) => p.includes("id")));
  assert.ok(caseProblems({ ...good(), why: "short" }).some((p) => p.includes("why")));
  assert.ok(caseProblems({ ...good(), expect: { outcome: "fail" } }).some((p) => p.includes("weak areas")));
  assert.ok(caseProblems({ ...good(), expect: { outcome: "pass", weakAreas: ["story"] } }).some((p) => p.includes("no weak areas")));
  assert.ok(caseProblems({ ...good(), expect: { outcome: "fail", weakAreas: ["tone"] } }).some((p) => p.includes("unknown area")));
  assert.ok(caseProblems({ ...good(), task: { goal: "x" } }).some((p) => p.startsWith("task:")));
});

test("a trial is right only when the decision and the reason both match the label", () => {
  const e = (out: unknown) => evaluateTicket(fullTask(), "acme/app", out, T);
  assert.equal(judgeTrial(good(), e(scores(5))), "correct");
  assert.equal(judgeTrial(good(), e(scores(4))), "false-reject");
  assert.equal(judgeTrial(bad(["testCases"]), e(scores(5))), "false-accept");
  assert.equal(judgeTrial(bad(["testCases"]), e(scores(5, { testCases: 2 }))), "correct");
  // Refused, but the evaluator blamed a different area: the weakness went unseen.
  assert.equal(judgeTrial(bad(["testCases"]), e(scores(5, { story: 2 }))), "wrong-reason");
  // Refused on the average alone, with the labelled area still at 4 or above.
  assert.equal(judgeTrial(bad(["testCases"]), e(scores(4))), "wrong-reason");
  assert.equal(judgeTrial(bad(["story", "testCases"]), e(scores(5, { story: 3 }))), "correct");
  assert.equal(judgeTrial({ ...good(), expect: { outcome: "borderline" } }, e(scores(4))), "borderline");
});

test("a run repeats each case, totals the spend and reports disagreement between identical runs", async () => {
  const answers = [scores(5), scores(4.2), scores(5), scores(5, { testCases: 2 }), scores(5, { testCases: 2 }), scores(5, { testCases: 2 })];
  let calls = 0;
  const report = await runTickets([good(), bad(["testCases"])], { trials: 3, thresholds: T, maxUsd: 10, ask: () => ({ output: answers[calls++], usd: 0.02 }) });
  assert.equal(calls, 6);
  assert.equal(report.spentUsd, 0.12);
  const [g, b] = report.results;
  assert.deepEqual(g!.trials.map((t) => t.verdict), ["correct", "false-reject", "correct"]);
  assert.equal(g!.flipped, true);
  assert.ok(g!.spread > 0.3);
  assert.equal(b!.flipped, false);
  assert.equal(b!.spread, 0);
  assert.deepEqual(summarise(report), { trials: 6, scored: 6, correct: 5, falseAccepts: 0, falseRejects: 1, wrongReason: 0, flippedCases: ["good"], maxSpread: g!.spread });
  const text = renderReport(report, { model: "sonnet", trials: 3 });
  assert.ok(text.includes("Correct decisions: 5 of 6"));
  assert.ok(text.includes("False rejects (a good ticket refused): 1"));
  assert.ok(text.includes("identical runs disagreed: 1 (good)"));
  assert.ok(text.includes("| bad | fail (testCases) | correct, correct, correct |"));
});

test("plain-check cases run once and never call the model", async () => {
  const plain = cases.filter((c) => c.id.startsWith("plain-"));
  let calls = 0;
  const report = await runTickets(plain, { trials: 3, thresholds: T, maxUsd: 10, ask: () => (calls++, { output: scores(5), usd: 1 }) });
  assert.equal(calls, 0);
  assert.equal(report.spentUsd, 0);
  assert.ok(report.results.every((r) => r.trials.length === 1 && r.trials[0]!.verdict === "correct" && !r.trials[0]!.askedModel));
  assert.ok(renderReport(report, { model: "sonnet", trials: 3 }).includes("correct, plain checks"));
});

test("the spending limit stops a run and says which cases were left out", async () => {
  const many = ["a", "b", "c"].map((id) => ({ ...good(), id }));
  let calls = 0;
  const report = await runTickets(many, { trials: 2, thresholds: T, maxUsd: 0.05, ask: () => (calls++, { output: scores(5), usd: 0.03 }) });
  assert.equal(calls, 2);
  assert.deepEqual(report.skipped, ["b", "c"]);
  assert.ok(renderReport(report, { model: "sonnet", trials: 2 }).includes("Not run, because the spending limit was reached: b, c."));
});

test("the estimate counts only the cases that need the model", () => {
  const e = estimate(cases, 3, 0.025);
  const needing = cases.filter((c) => !c.id.startsWith("plain-")).length;
  assert.deepEqual(e, { modelCalls: needing * 3, usd: Math.round(needing * 3 * 0.025 * 100) / 100, free: cases.length - needing });
});

test("the command shows its estimate and refuses to spend without being told to", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, "src/evals/cli.ts"), ...args], { encoding: "utf8" });
  const dry = run(["tickets", "--dry-run"]);
  assert.equal(dry.status, 0);
  assert.match(dry.stderr, /model call\(s\) on sonnet, about \$\d+\.\d\d, capped at \$2\.00/);
  const noYes = run(["tickets"]);
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /Re-run with --yes/);
  assert.equal(run(["tickets", "--only", "no-such-case", "--dry-run"]).status, 1);
  assert.equal(run(["judge"]).status, 1);
});

test("the index of cases lists every case with its label", () => {
  const index = readFileSync(join(root, "evals/README.md"), "utf8");
  for (const c of cases) assert.ok(index.includes(`\`${c.id}\``), c.id);
});
