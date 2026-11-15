/** Task contract and approval binding (docs/spec.md §7). */
import { digest } from "./digest.ts";

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface Criterion {
  id: string;
  behavior: string;
  evidence: string;
}

export interface Task {
  goal: string;
  acceptance: Criterion[];
  /** Digest of the hidden scenarios, or a justification for omitting them. */
  scenarios: { digest: string } | { omitted: string };
  nonGoals: string[];
  scope: { components: string[]; permitted: string[]; forbidden: string[] };
  risk: { level: RiskLevel; concerns: string[] };
  context?: string[];
  reuse?: string[];
  approach?: string;
  verification?: string[];
  run?: string[];
  exceptions?: { scope: string; rationale: string; replacementEvidence: string }[];
  dependsOn?: string[];
  budget?: Record<string, number>;
}

export const REQUIRED_TASK_FIELDS = ["goal", "acceptance", "scenarios", "nonGoals", "scope", "risk"] as const;

const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns every problem found; an empty list means the task is well formed. */
export function taskProblems(input: unknown): string[] {
  if (!isObject(input)) return ["task must be an object"];
  const problems: string[] = [];
  for (const field of REQUIRED_TASK_FIELDS) {
    if (!(field in input)) problems.push(`missing required field '${field}'`);
  }
  if ("goal" in input && !isText(input.goal)) problems.push("goal must be non-empty text");

  if ("acceptance" in input) {
    const list = input.acceptance;
    if (!Array.isArray(list) || list.length === 0) {
      problems.push("acceptance must list at least one criterion");
    } else {
      const seen = new Set<string>();
      list.forEach((c, i) => {
        if (!isObject(c) || !isText(c.id) || !isText(c.behavior) || !isText(c.evidence)) {
          problems.push(`acceptance[${i}] needs id, behavior and evidence`);
          return;
        }
        if (seen.has(c.id)) problems.push(`duplicate criterion id '${c.id}'`);
        seen.add(c.id);
      });
    }
  }

  if ("scenarios" in input) {
    const s = input.scenarios;
    const ok = isObject(s) && (/^sha256:[0-9a-f]{64}$/.test(String(s.digest ?? "")) || isText(s.omitted));
    if (!ok) problems.push("scenarios needs a sha256 digest, or a justification in 'omitted'");
  }

  if ("nonGoals" in input && !isTextList(input.nonGoals)) problems.push("nonGoals must be a list of text");

  if ("scope" in input) {
    const s = input.scope;
    if (!isObject(s) || !isTextList(s.components) || !isTextList(s.permitted) || !isTextList(s.forbidden)) {
      problems.push("scope needs components, permitted and forbidden lists");
    }
  }

  if ("risk" in input) {
    const r = input.risk;
    if (!isObject(r) || !RISK_LEVELS.includes(r.level as RiskLevel) || !isTextList(r.concerns)) {
      problems.push(`risk needs a level (${RISK_LEVELS.join(", ")}) and a concerns list`);
    }
  }
  return problems;
}

export interface Approval {
  taskDigest: string;
  policyDigest: string;
  repository: string;
  approver: string;
  approvedAt: string;
}

export function approve(
  task: Task,
  details: Omit<Approval, "taskDigest">,
): Approval {
  const problems = taskProblems(task);
  if (problems.length) throw new Error(`cannot approve a malformed task: ${problems.join("; ")}`);
  return { ...details, taskDigest: digest(task) };
}

/**
 * An approval covers exactly one task text, policy and repository. Any edit to
 * the task after approval changes its digest and voids the approval.
 */
export function approvalProblems(
  approval: Approval,
  current: { task: unknown; policyDigest: string; repository: string; approvers: readonly string[] },
): string[] {
  const problems: string[] = [];
  if (approval.taskDigest !== digest(current.task)) problems.push("task changed after approval");
  if (approval.policyDigest !== current.policyDigest) problems.push("policy changed after approval");
  if (approval.repository !== current.repository) problems.push("approval is for a different repository");
  if (!current.approvers.includes(approval.approver)) problems.push(`'${approval.approver}' is not an approver`);
  return problems;
}
