/** The judge's structured verdict (docs/spec.md §10). Model output is validated here before anything trusts it. */
import type { Task } from "../control/task.ts";

export interface Verdict {
  verdict: "accept" | "reject" | "inconclusive";
  criteria: { id: string; result: "met" | "unmet" | "inconclusive"; reasoning: string }[];
  findings: { severity: "blocking" | "non-blocking"; summary: string; detail?: string }[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Shape and coverage problems. An empty list means the verdict can be interpreted. */
export function verdictProblems(task: Task, input: unknown): string[] {
  if (!isObject(input)) return ["verdict is not an object"];
  const problems: string[] = [];
  if (!["accept", "reject", "inconclusive"].includes(input.verdict as string)) problems.push("verdict value is not recognised");
  if (!Array.isArray(input.criteria)) return [...problems, "criteria is not a list"];
  if (!Array.isArray(input.findings)) return [...problems, "findings is not a list"];

  const wanted = new Set(task.acceptance.map((c) => c.id));
  const seen = new Set<string>();
  for (const c of input.criteria) {
    if (!isObject(c) || typeof c.id !== "string" || typeof c.reasoning !== "string" || !["met", "unmet", "inconclusive"].includes(c.result as string)) {
      problems.push("a criterion entry is malformed");
      continue;
    }
    if (!wanted.has(c.id)) problems.push(`verdict names unknown criterion '${c.id}'`);
    if (seen.has(c.id)) problems.push(`criterion '${c.id}' is judged more than once`);
    seen.add(c.id);
  }
  for (const id of wanted) if (!seen.has(id)) problems.push(`criterion '${id}' is not judged`);
  for (const f of input.findings) {
    if (!isObject(f) || typeof f.summary !== "string" || !["blocking", "non-blocking"].includes(f.severity as string)) {
      problems.push("a finding is malformed");
    }
  }
  return problems;
}

export type Decision = "accept" | "reject" | "inconclusive";

/**
 * The pipeline's reading of a verdict. The judge's own `verdict` field can only
 * make the outcome stricter: acceptance also requires every criterion met and
 * no blocking finding, whatever the summary field claims.
 */
export function decide(task: Task, input: unknown): { decision: Decision; reasons: string[] } {
  const problems = verdictProblems(task, input);
  if (problems.length) return { decision: "inconclusive", reasons: problems };
  const v = input as Verdict;
  const reasons: string[] = [];
  const unmet = v.criteria.filter((c) => c.result === "unmet").map((c) => c.id);
  const unsure = v.criteria.filter((c) => c.result === "inconclusive").map((c) => c.id);
  const blocking = v.findings.filter((f) => f.severity === "blocking");
  if (unmet.length) reasons.push(`unmet: ${unmet.join(", ")}`);
  if (blocking.length) reasons.push(`${blocking.length} blocking finding(s)`);
  if (v.verdict === "reject") reasons.push("judge rejected");
  if (reasons.length) return { decision: "reject", reasons };
  if (unsure.length) reasons.push(`inconclusive: ${unsure.join(", ")}`);
  if (v.verdict === "inconclusive") reasons.push("judge was inconclusive");
  if (reasons.length) return { decision: "inconclusive", reasons };
  return { decision: "accept", reasons: [] };
}
