/**
 * Golden-set evaluation of the ticket evaluator. Each case is a ticket a
 * person has labelled: it should pass, or it should be refused and for a
 * stated reason. The harness runs the same scoring the pipeline runs, several
 * times per case, and reports wrong decisions, right decisions made for the
 * wrong reason, and how much the scores move between identical runs.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Task, taskProblems } from "../control/task.ts";
import { AREAS, type Area, type Evaluation, evaluateTicket, failsWithoutModel } from "../run/evaluate.ts";

export interface TicketCase {
  id: string;
  /** Why a person labelled it this way. */
  why: string;
  repository: string;
  task: Task;
  expect: {
    /** `borderline` cases are reported but not counted as right or wrong. */
    outcome: "pass" | "fail" | "borderline";
    /** For a `fail` case: at least one of these areas must be the reason. */
    weakAreas?: Area[];
  };
}

export function caseProblems(c: unknown): string[] {
  const x = c as Partial<TicketCase>;
  const problems: string[] = [];
  if (typeof x?.id !== "string" || !/^[a-z0-9-]+$/.test(x.id)) problems.push("id must be lower-case letters, digits and hyphens");
  if (typeof x?.why !== "string" || x.why.trim().length < 20) problems.push("why must explain the label");
  if (typeof x?.repository !== "string") problems.push("repository is missing");
  problems.push(...taskProblems(x?.task).map((p) => `task: ${p}`));
  const outcome = x?.expect?.outcome;
  if (!["pass", "fail", "borderline"].includes(outcome as string)) problems.push("expect.outcome must be pass, fail or borderline");
  const weak = x?.expect?.weakAreas;
  if (outcome === "fail" && (!Array.isArray(weak) || weak.length === 0)) problems.push("a fail case must name the weak areas");
  if (weak && !weak.every((a) => (AREAS as readonly string[]).includes(a))) problems.push("weakAreas names an unknown area");
  if (outcome === "pass" && weak?.length) problems.push("a pass case has no weak areas");
  return problems;
}

export function loadCases(dir: string): TicketCase[] {
  const cases: TicketCase[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const c = JSON.parse(readFileSync(join(dir, file), "utf8")) as TicketCase;
    const problems = caseProblems(c);
    if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
    if (`${c.id}.json` !== file) throw new Error(`${file}: id '${c.id}' does not match the file name`);
    cases.push(c);
  }
  return cases;
}

export type TrialVerdict = "correct" | "false-accept" | "false-reject" | "wrong-reason" | "borderline";

export interface Trial {
  evaluation: Evaluation;
  verdict: TrialVerdict;
  usd: number | null;
  /** False when plain checks decided the outcome and no model was called. */
  askedModel: boolean;
}

export function judgeTrial(c: TicketCase, evaluation: Evaluation): TrialVerdict {
  if (c.expect.outcome === "borderline") return "borderline";
  if (c.expect.outcome === "pass") return evaluation.passed ? "correct" : "false-reject";
  if (evaluation.passed) return "false-accept";
  // Refused, as it should be. It only counts if the evaluator saw the actual weakness.
  const sawIt = (c.expect.weakAreas ?? []).some((a) => evaluation.areas[a].score < evaluation.minArea);
  return sawIt ? "correct" : "wrong-reason";
}

export interface CaseResult {
  case: TicketCase;
  trials: Trial[];
  /** Standard deviation of the average score across trials. */
  spread: number;
  /** True when identical runs reached different decisions. */
  flipped: boolean;
}

export interface Answer {
  output: unknown;
  usd: number | null;
}

export interface RunOptions {
  trials: number;
  thresholds: { minMean: number; minArea: number };
  /** Ask the model to score one ticket. */
  ask: (task: Task) => Promise<Answer> | Answer;
  /** Stop asking once reported spend reaches this. */
  maxUsd: number;
  onTrial?: (c: TicketCase, trial: Trial, index: number) => void;
}

export interface RunReport {
  results: CaseResult[];
  spentUsd: number;
  /** Cases not run because the spending limit was reached. */
  skipped: string[];
}

const stdev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.round(Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) * 100) / 100;
};

export async function runTickets(cases: TicketCase[], o: RunOptions): Promise<RunReport> {
  const report: RunReport = { results: [], spentUsd: 0, skipped: [] };
  for (const c of cases) {
    const needsModel = !failsWithoutModel(c.task, c.repository);
    if (needsModel && report.spentUsd >= o.maxUsd) {
      report.skipped.push(c.id);
      continue;
    }
    const trials: Trial[] = [];
    // Plain checks give the same answer every time, so one trial is enough for them.
    const count = needsModel ? o.trials : 1;
    for (let i = 0; i < count; i++) {
      if (needsModel && report.spentUsd >= o.maxUsd) break;
      const answer = needsModel ? await o.ask(c.task) : { output: null, usd: 0 };
      report.spentUsd += answer.usd ?? 0;
      const evaluation = evaluateTicket(c.task, c.repository, answer.output, o.thresholds);
      const trial: Trial = { evaluation, verdict: judgeTrial(c, evaluation), usd: answer.usd, askedModel: needsModel };
      trials.push(trial);
      o.onTrial?.(c, trial, i);
    }
    report.results.push({
      case: c,
      trials,
      spread: stdev(trials.map((t) => t.evaluation.mean)),
      flipped: new Set(trials.map((t) => t.evaluation.passed)).size > 1,
    });
  }
  report.spentUsd = Math.round(report.spentUsd * 10000) / 10000;
  return report;
}

export interface Summary {
  trials: number;
  scored: number;
  correct: number;
  falseAccepts: number;
  falseRejects: number;
  wrongReason: number;
  flippedCases: string[];
  maxSpread: number;
}

export function summarise(report: RunReport): Summary {
  const all = report.results.flatMap((r) => r.trials);
  const count = (v: TrialVerdict) => all.filter((t) => t.verdict === v).length;
  return {
    trials: all.length,
    scored: all.filter((t) => t.verdict !== "borderline").length,
    correct: count("correct"),
    falseAccepts: count("false-accept"),
    falseRejects: count("false-reject"),
    wrongReason: count("wrong-reason"),
    flippedCases: report.results.filter((r) => r.flipped).map((r) => r.case.id),
    maxSpread: Math.max(0, ...report.results.map((r) => r.spread)),
  };
}

export function renderReport(report: RunReport, meta: { model: string; trials: number }): string {
  const s = summarise(report);
  const lines = [
    `# Ticket evaluator: golden set`,
    "",
    `Model \`${meta.model}\`, ${meta.trials} trial(s) per case that needs the model, ${report.results.length} case(s), estimated spend $${report.spentUsd.toFixed(2)}.`,
    "",
    `- Correct decisions: ${s.correct} of ${s.scored}`,
    `- False accepts (a bad ticket passed): ${s.falseAccepts}`,
    `- False rejects (a good ticket refused): ${s.falseRejects}`,
    `- Refused, but not for the labelled reason: ${s.wrongReason}`,
    `- Cases where identical runs disagreed: ${s.flippedCases.length}${s.flippedCases.length ? ` (${s.flippedCases.join(", ")})` : ""}`,
    `- Largest spread in average score between identical runs: ${s.maxSpread}`,
    "",
    "| Case | Expected | Results | Average scores | Spread | Lowest area |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of report.results) {
    const expect = r.case.expect.outcome === "fail" ? `fail (${r.case.expect.weakAreas!.join(", ")})` : r.case.expect.outcome;
    const first = r.trials[0];
    const lowest = first ? AREAS.reduce((a, b) => (first.evaluation.areas[b].score < first.evaluation.areas[a].score ? b : a)) : null;
    lines.push(
      `| ${r.case.id} | ${expect} | ${r.trials.map((t) => (t.askedModel ? t.verdict : `${t.verdict}, plain checks`)).join(", ")} | ${r.trials.map((t) => t.evaluation.mean).join(", ")} | ${r.spread} | ${lowest ? `${lowest} ${first!.evaluation.areas[lowest].score}` : ""} |`,
    );
  }
  if (report.skipped.length) lines.push("", `Not run, because the spending limit was reached: ${report.skipped.join(", ")}.`);
  return lines.join("\n");
}

/** What a run will cost at most, for showing before it starts. */
export function estimate(cases: TicketCase[], trials: number, usdPerCall: number): { modelCalls: number; usd: number; free: number } {
  const needing = cases.filter((c) => !failsWithoutModel(c.task, c.repository)).length;
  return { modelCalls: needing * trials, usd: Math.round(needing * trials * usdPerCall * 100) / 100, free: cases.length - needing };
}
