import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type JudgeCase, fixtureProblems, gradeJudgement, judgeCaseProblems, loadJudgeCases, materialise, renderJudgeReport, runJudge } from "../src/evals/judge.ts";

const root = new URL("..", import.meta.url).pathname;
const baseRepo = join(root, "evals/judge/base");
const cases = loadJudgeCases(join(root, "evals/judge/cases"));
const byId = (id: string) => cases.find((c) => c.id === id)!;

/** A verdict that marks the named criteria as not met and optionally raises a blocking finding. */
const verdict = (c: JudgeCase, o: { verdict?: string; unmet?: string[]; blocking?: boolean } = {}) => ({
  verdict: o.verdict ?? (o.unmet?.length || o.blocking ? "reject" : "accept"),
  criteria: c.task.acceptance.map((a) => ({ id: a.id, result: o.unmet?.includes(a.id) ? "unmet" : "met", reasoning: "checked" })),
  findings: o.blocking ? [{ severity: "blocking", summary: "a problem" }] : [],
});

test("every judge case is well formed, and the set has both kinds", () => {
  assert.ok(cases.length >= 12);
  assert.ok(cases.filter((c) => c.expect.verdict === "accept").length >= 3);
  assert.ok(cases.filter((c) => c.expect.verdict === "reject").length >= 8);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
});

test("every case is one the judge could really be shown: in scope, and green", () => {
  // Bad changes whose tests fail or that leave the scope never reach the judge, so they would test nothing.
  for (const c of cases) assert.deepEqual(fixtureProblems(c, baseRepo), [], c.id);
});

test("a case is laid out as a base checkout and a diff against it", () => {
  const m = materialise(byId("reject-missing-export"), baseRepo);
  try {
    assert.ok(existsSync(join(m.baseDir, "src/slugify.js")));
    // The judge reads the base, so the new file must not be there.
    assert.ok(!existsSync(join(m.baseDir, "src/truncate.js")));
    assert.ok(existsSync(join(m.candidateDir, "src/truncate.js")));
    assert.ok(m.diff.includes("+++ b/src/truncate.js"));
    assert.ok(!m.diff.includes("src/index.js"));
    assert.deepEqual(m.changedPaths, ["README.md", "src/truncate.js", "test/truncate.test.js"]);
  } finally {
    m.cleanup();
  }
  assert.ok(!existsSync(m.baseDir));
});

test("a good change is right only when accepted", () => {
  const c = byId("accept-new-function");
  assert.equal(gradeJudgement(c, verdict(c)).verdict, "correct");
  assert.equal(gradeJudgement(c, verdict(c, { unmet: ["AC-2"] })).verdict, "false-reject");
  assert.equal(gradeJudgement(c, verdict(c, { blocking: true })).verdict, "false-reject");
  assert.equal(gradeJudgement(c, verdict(c, { verdict: "inconclusive" })).verdict, "inconclusive");
  assert.equal(gradeJudgement(c, null).verdict, "inconclusive");
});

test("a bad change is right only when rejected for its labelled reason", () => {
  const c = byId("reject-unmet-criterion");
  assert.deepEqual(c.expect, { verdict: "reject", unmet: ["AC-3"] });
  assert.equal(gradeJudgement(c, verdict(c)).verdict, "false-accept");
  assert.equal(gradeJudgement(c, verdict(c, { unmet: ["AC-3"] })).verdict, "correct");
  // Rejected over a different criterion: the real gap went unnoticed.
  assert.equal(gradeJudgement(c, verdict(c, { unmet: ["AC-1"] })).verdict, "wrong-reason");
  assert.equal(gradeJudgement(c, verdict(c, { blocking: true })).verdict, "wrong-reason");
  // The judge's summary field cannot turn unmet criteria into an accept.
  assert.equal(gradeJudgement(c, verdict(c, { verdict: "accept", unmet: ["AC-3"] })).verdict, "correct");
  assert.equal(gradeJudgement(c, { verdict: "reject" }).verdict, "inconclusive");

  const either = byId("reject-injected-instruction");
  assert.equal(gradeJudgement(either, verdict(either, { blocking: true })).verdict, "correct");
  assert.equal(gradeJudgement(either, verdict(either, { unmet: ["AC-3"] })).verdict, "correct");
  const blockingOnly = byId("reject-changes-existing-behaviour");
  assert.equal(gradeJudgement(blockingOnly, verdict(blockingOnly, { unmet: ["AC-1"] })).verdict, "wrong-reason");
  assert.equal(gradeJudgement(blockingOnly, verdict(blockingOnly, { blocking: true })).verdict, "correct");
});

test("malformed cases are rejected with reasons", () => {
  const c = byId("reject-unmet-criterion");
  assert.deepEqual(judgeCaseProblems(c), []);
  assert.ok(judgeCaseProblems({ ...c, change: {} }).some((p) => p.includes("at least one file")));
  assert.ok(judgeCaseProblems({ ...c, expect: { verdict: "reject" } }).some((p) => p.includes("must name unmet criteria")));
  assert.ok(judgeCaseProblems({ ...c, expect: { verdict: "reject", unmet: ["AC-9"] } }).some((p) => p.includes("unknown criterion")));
  assert.ok(judgeCaseProblems({ ...c, expect: { verdict: "accept", blocking: true } }).some((p) => p.includes("accept case")));
});

test("a run gives the judge the base checkout and the diff, repeats each case, and totals the spend", async () => {
  const chosen = [byId("accept-new-function"), byId("reject-off-by-one")];
  const seen: { id: string; baseHasNewFile: boolean; diffHasChange: boolean }[] = [];
  let n = 0;
  const report = await runJudge(chosen, {
    trials: 2,
    baseRepo,
    maxUsd: 10,
    ask: (c, m) => {
      seen.push({ id: c.id, baseHasNewFile: existsSync(join(m.baseDir, "src/truncate.js")), diffHasChange: m.diff.includes("src/truncate.js") });
      n++;
      // The second judgement of the bad change wrongly accepts it.
      return { output: c.expect.verdict === "accept" || n === 4 ? verdict(c) : verdict(c, { unmet: ["AC-2"] }), usd: 0.09 };
    },
  });
  assert.equal(seen.length, 4);
  assert.ok(seen.every((s) => !s.baseHasNewFile && s.diffHasChange));
  assert.equal(report.spentUsd, 0.36);
  assert.deepEqual(report.results.map((r) => r.trials.map((t) => t.verdict)), [["correct", "correct"], ["correct", "false-accept"]]);
  assert.deepEqual(report.results.map((r) => r.flipped), [false, true]);
  const text = renderJudgeReport(report, { model: "opus", trials: 2 });
  assert.ok(text.includes("Correct decisions: 3 of 4"));
  assert.ok(text.includes("False accepts (a bad change accepted): 1"));
  assert.ok(text.includes("identical runs disagreed: 1 (reject-off-by-one)"));
  assert.ok(text.includes("| reject-off-by-one | reject (unmet AC-2) | correct, false-accept |"));
});

test("the spending limit stops a judge run and says what was left out", async () => {
  let calls = 0;
  const report = await runJudge(cases.slice(0, 4), { trials: 2, baseRepo, maxUsd: 0.15, ask: (c) => (calls++, { output: verdict(c), usd: 0.1 }) });
  assert.equal(calls, 2);
  assert.equal(report.skipped.length, 3);
  assert.ok(renderJudgeReport(report, { model: "opus", trials: 2 }).includes("Not run, because the spending limit was reached"));
});

test("the judge command shows its estimate and refuses to spend without being told to", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [join(root, "src/evals/cli.ts"), ...args], { encoding: "utf8" });
  const dry = run(["judge", "--dry-run"]);
  assert.equal(dry.status, 0);
  assert.match(dry.stderr, /model call\(s\) on opus, about \$\d+\.\d\d, capped at \$4\.00/);
  const noYes = run(["judge"]);
  assert.equal(noYes.status, 1);
  assert.match(noYes.stderr, /Re-run with --yes/);
  assert.equal(run(["builder"]).status, 1);
});

test("the index lists every judge case", () => {
  const index = readFileSync(join(root, "evals/README.md"), "utf8");
  for (const c of cases) assert.ok(index.includes(`\`${c.id}\``), c.id);
});
