/**
 * Golden-set evaluation of the judge. Each case is a task and a code change a
 * person has labelled: the judge should accept it, or reject it for a stated
 * reason. Every change, good or bad, passes the repository's tests and stays
 * inside the task's scope, because those are the only changes the judge ever
 * sees in the pipeline.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { candidateViolations } from "../control/guards.ts";
import { type Task, taskProblems } from "../control/task.ts";
import { type Decision, type Verdict, decide, verdictProblems } from "../run/verdict.ts";

export interface JudgeCase {
  id: string;
  /** Why a person labelled it this way. */
  why: string;
  task: Task;
  /** Files as they are after the change. `null` deletes a file. */
  change: Record<string, string | null>;
  expect: {
    verdict: "accept" | "reject";
    /** For a reject: criteria the judge should mark as not met. */
    unmet?: string[];
    /** For a reject: the judge should raise a blocking finding. */
    blocking?: boolean;
  };
}

export function judgeCaseProblems(c: unknown): string[] {
  const x = c as Partial<JudgeCase>;
  const problems: string[] = [];
  if (typeof x?.id !== "string" || !/^[a-z0-9-]+$/.test(x.id)) problems.push("id must be lower-case letters, digits and hyphens");
  if (typeof x?.why !== "string" || x.why.trim().length < 20) problems.push("why must explain the label");
  problems.push(...taskProblems(x?.task).map((p) => `task: ${p}`));
  if (!x?.change || Object.keys(x.change).length === 0) problems.push("change must touch at least one file");
  const e = x?.expect;
  if (e?.verdict !== "accept" && e?.verdict !== "reject") problems.push("expect.verdict must be accept or reject");
  if (e?.verdict === "accept" && (e.unmet?.length || e.blocking)) problems.push("an accept case has no unmet criteria or blocking finding");
  if (e?.verdict === "reject" && !e.unmet?.length && !e.blocking) problems.push("a reject case must name unmet criteria or expect a blocking finding");
  const ids = new Set((x?.task?.acceptance ?? []).map((a) => a.id));
  for (const id of e?.unmet ?? []) if (!ids.has(id)) problems.push(`expect.unmet names unknown criterion '${id}'`);
  return problems;
}

export function loadJudgeCases(dir: string): JudgeCase[] {
  const cases: JudgeCase[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const c = JSON.parse(readFileSync(join(dir, file), "utf8")) as JudgeCase;
    const problems = judgeCaseProblems(c);
    if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
    if (`${c.id}.json` !== file) throw new Error(`${file}: id '${c.id}' does not match the file name`);
    cases.push(c);
  }
  return cases;
}

export interface Materialised {
  /** A copy of the base repository, as the judge sees it. */
  baseDir: string;
  /** The base repository with the change applied. */
  candidateDir: string;
  /** The change as the pipeline would present it. */
  diff: string;
  changedPaths: string[];
  cleanup: () => void;
}

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "eval", GIT_AUTHOR_EMAIL: "eval@example.invalid", GIT_COMMITTER_NAME: "eval", GIT_COMMITTER_EMAIL: "eval@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Lay a case out on disk the way the pipeline would: a base checkout and the diff against it. */
export function materialise(c: JudgeCase, baseRepo: string): Materialised {
  const root = mkdtempSync(join(tmpdir(), `factory-judge-${c.id}-`));
  const baseDir = join(root, "base");
  const candidateDir = join(root, "candidate");
  cpSync(baseRepo, baseDir, { recursive: true });
  cpSync(baseRepo, candidateDir, { recursive: true });
  git(candidateDir, "init", "-q", "-b", "main");
  git(candidateDir, "add", "-A");
  git(candidateDir, "commit", "-q", "-m", "base");
  for (const [path, content] of Object.entries(c.change)) {
    const file = join(candidateDir, path);
    if (content === null) rmSync(file, { force: true });
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  git(candidateDir, "add", "-A");
  const diff = git(candidateDir, "diff", "--cached", "--no-ext-diff", "--no-textconv");
  const changedPaths = git(candidateDir, "diff", "--cached", "--name-only", "--no-renames").trim().split("\n").filter(Boolean);
  return { baseDir, candidateDir, diff, changedPaths, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Checks that a case is one the judge could really be shown: its change stays
 * inside the task's scope and the tests pass with it applied. Runs the case's
 * own test files, so it is for the fixtures in this repository only.
 */
export function fixtureProblems(c: JudgeCase, baseRepo: string): string[] {
  const m = materialise(c, baseRepo);
  try {
    const problems = candidateViolations({ changedPaths: m.changedPaths, scope: c.task.scope }).map((v) => `${v.path}: ${v.kind}`);
    if (!m.diff.trim()) problems.push("the change is empty");
    try {
      execFileSync(process.execPath, ["--test"], { cwd: m.candidateDir, stdio: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    } catch {
      problems.push("the tests do not pass with the change applied");
    }
    return problems;
  } finally {
    m.cleanup();
  }
}

export type JudgeTrialVerdict = "correct" | "false-accept" | "false-reject" | "wrong-reason" | "inconclusive";

export interface JudgeTrial {
  decision: Decision;
  reasons: string[];
  verdict: JudgeTrialVerdict;
  usd: number | null;
}

/** Grade one judgement against the label. `output` is the judge's structured verdict, untrusted. */
export function gradeJudgement(c: JudgeCase, output: unknown): { decision: Decision; reasons: string[]; verdict: JudgeTrialVerdict } {
  const { decision, reasons } = decide(c.task, output);
  if (c.expect.verdict === "accept") {
    return { decision, reasons, verdict: decision === "accept" ? "correct" : decision === "inconclusive" ? "inconclusive" : "false-reject" };
  }
  if (decision === "accept") return { decision, reasons, verdict: "false-accept" };
  // An unusable or undecided verdict stops the change but tells nobody why.
  if (decision === "inconclusive" || verdictProblems(c.task, output).length) return { decision, reasons, verdict: "inconclusive" };
  const v = output as Verdict;
  const sawUnmet = (c.expect.unmet ?? []).some((id) => v.criteria.some((x) => x.id === id && x.result !== "met"));
  const sawBlocking = c.expect.blocking === true && v.findings.some((f) => f.severity === "blocking");
  return { decision, reasons, verdict: sawUnmet || sawBlocking ? "correct" : "wrong-reason" };
}

export interface JudgeCaseResult {
  case: JudgeCase;
  trials: JudgeTrial[];
  /** True when identical runs reached different decisions. */
  flipped: boolean;
}

export interface JudgeRunOptions {
  trials: number;
  baseRepo: string;
  maxUsd: number;
  /** Ask the judge about one laid-out case. */
  ask: (c: JudgeCase, m: Materialised) => Promise<{ output: unknown; usd: number | null }> | { output: unknown; usd: number | null };
  onTrial?: (c: JudgeCase, t: JudgeTrial, index: number) => void;
}

export interface JudgeReport {
  results: JudgeCaseResult[];
  spentUsd: number;
  skipped: string[];
}

export async function runJudge(cases: JudgeCase[], o: JudgeRunOptions): Promise<JudgeReport> {
  const report: JudgeReport = { results: [], spentUsd: 0, skipped: [] };
  for (const c of cases) {
    if (report.spentUsd >= o.maxUsd) {
      report.skipped.push(c.id);
      continue;
    }
    const m = materialise(c, o.baseRepo);
    const trials: JudgeTrial[] = [];
    try {
      for (let i = 0; i < o.trials && report.spentUsd < o.maxUsd; i++) {
        const answer = await o.ask(c, m);
        report.spentUsd += answer.usd ?? 0;
        const trial: JudgeTrial = { ...gradeJudgement(c, answer.output), usd: answer.usd };
        trials.push(trial);
        o.onTrial?.(c, trial, i);
      }
    } finally {
      m.cleanup();
    }
    report.results.push({ case: c, trials, flipped: new Set(trials.map((t) => t.decision)).size > 1 });
  }
  report.spentUsd = Math.round(report.spentUsd * 10000) / 10000;
  return report;
}

export function renderJudgeReport(report: JudgeReport, meta: { model: string; trials: number }): string {
  const all = report.results.flatMap((r) => r.trials);
  const count = (v: JudgeTrialVerdict) => all.filter((t) => t.verdict === v).length;
  const flipped = report.results.filter((r) => r.flipped).map((r) => r.case.id);
  const lines = [
    "# Judge: golden set",
    "",
    `Model \`${meta.model}\`, ${meta.trials} trial(s) per case, ${report.results.length} case(s), estimated spend $${report.spentUsd.toFixed(2)}.`,
    "",
    `- Correct decisions: ${count("correct")} of ${all.length}`,
    `- False accepts (a bad change accepted): ${count("false-accept")}`,
    `- False rejects (a good change rejected): ${count("false-reject")}`,
    `- Rejected, but not for the labelled reason: ${count("wrong-reason")}`,
    `- Inconclusive or unusable verdicts: ${count("inconclusive")}`,
    `- Cases where identical runs disagreed: ${flipped.length}${flipped.length ? ` (${flipped.join(", ")})` : ""}`,
    "",
    "| Case | Expected | Results |",
    "|---|---|---|",
  ];
  for (const r of report.results) {
    const e = r.case.expect;
    const why = [e.unmet?.length ? `unmet ${e.unmet.join(", ")}` : "", e.blocking ? "blocking finding" : ""].filter(Boolean).join(" or ");
    lines.push(`| ${r.case.id} | ${e.verdict}${why ? ` (${why})` : ""} | ${r.trials.map((t) => t.verdict).join(", ")} |`);
  }
  if (report.skipped.length) lines.push("", `Not run, because the spending limit was reached: ${report.skipped.join(", ")}.`);
  return lines.join("\n");
}
