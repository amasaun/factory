/** Budgets from docs/spec.md §13. All limits apply simultaneously. */

export const PHASES = ["initial", "repair", "ci", "refresh", "feedback"] as const;
export type Phase = (typeof PHASES)[number];
export type Role = "builder" | "judge";

export interface Limits {
  initialBuildAttempts: number;
  repairRounds: number;
  ciRepairCycles: number;
  refreshReserve: { builder: number; judge: number };
  totalBuilder: number;
  totalJudge: number;
  feedbackRounds: number;
  infraRetries: number;
  activeMinutes: number;
}

export const DEFAULT_LIMITS: Limits = {
  initialBuildAttempts: 3,
  repairRounds: 2,
  ciRepairCycles: 1,
  refreshReserve: { builder: 1, judge: 1 },
  totalBuilder: 7,
  totalJudge: 5,
  feedbackRounds: 3,
  infraRetries: 3,
  activeMinutes: 90,
};

export interface Usage {
  builder: Record<Phase, number>;
  judge: Record<Phase, number>;
  feedbackRoundsGranted: number;
  infraRetries: number;
}

const zero = (): Record<Phase, number> => ({ initial: 0, repair: 0, ci: 0, refresh: 0, feedback: 0 });

export function emptyUsage(): Usage {
  return { builder: zero(), judge: zero(), feedbackRoundsGranted: 0, infraRetries: 0 };
}

export class BudgetError extends Error {
  override name = "BudgetError";
}

/** Per-phase cap for a role. Feedback capacity is granted by a reviewer, one round at a time. */
export function phaseCap(limits: Limits, usage: Usage, role: Role, phase: Phase): number {
  switch (phase) {
    case "initial":
      return role === "builder" ? limits.initialBuildAttempts : 1;
    case "repair":
      return limits.repairRounds;
    case "ci":
      return limits.ciRepairCycles;
    case "refresh":
      return limits.refreshReserve[role];
    case "feedback":
      return usage.feedbackRoundsGranted;
  }
}

const sum = (r: Record<Phase, number>) => PHASES.reduce((n, p) => n + r[p], 0);

export function totalCap(limits: Limits, usage: Usage, role: Role): number {
  return (role === "builder" ? limits.totalBuilder : limits.totalJudge) + usage.feedbackRoundsGranted;
}

/** Returns a reason when the invocation would exceed a limit, otherwise null. */
export function denyReason(limits: Limits, usage: Usage, role: Role, phase: Phase): string | null {
  const used = usage[role];
  if (used[phase] >= phaseCap(limits, usage, role, phase)) {
    return `${role} ${phase} limit reached (${used[phase]})`;
  }
  if (sum(used) >= totalCap(limits, usage, role)) {
    return `${role} total limit reached (${sum(used)})`;
  }
  return null;
}

export function consume(limits: Limits, usage: Usage, role: Role, phase: Phase): Usage {
  const reason = denyReason(limits, usage, role, phase);
  if (reason) throw new BudgetError(reason);
  return { ...usage, [role]: { ...usage[role], [phase]: usage[role][phase] + 1 } };
}

export function grantFeedbackRound(limits: Limits, usage: Usage): Usage {
  if (usage.feedbackRoundsGranted >= limits.feedbackRounds) {
    throw new BudgetError(`review feedback rounds exhausted (${usage.feedbackRoundsGranted})`);
  }
  return { ...usage, feedbackRoundsGranted: usage.feedbackRoundsGranted + 1 };
}

export function consumeInfraRetry(limits: Limits, usage: Usage): Usage {
  if (usage.infraRetries >= limits.infraRetries) {
    throw new BudgetError(`infrastructure retries exhausted (${usage.infraRetries})`);
  }
  return { ...usage, infraRetries: usage.infraRetries + 1 };
}

/**
 * A limit set is coherent when the totals cover every phase's allowance, so a
 * run can never be stranded with a required re-judgment it cannot afford.
 */
export function limitProblems(limits: Limits): string[] {
  const problems: string[] = [];
  const builderPhases =
    limits.initialBuildAttempts + limits.repairRounds + limits.ciRepairCycles + limits.refreshReserve.builder;
  const judgePhases = 1 + limits.repairRounds + limits.ciRepairCycles + limits.refreshReserve.judge;
  if (limits.totalBuilder < builderPhases) {
    problems.push(`totalBuilder ${limits.totalBuilder} is below the phase allowances (${builderPhases})`);
  }
  if (limits.totalJudge < judgePhases) {
    problems.push(`totalJudge ${limits.totalJudge} is below the phase allowances (${judgePhases})`);
  }
  for (const [name, value] of Object.entries({ ...limits, ...limits.refreshReserve, refreshReserve: 0 })) {
    if (!Number.isInteger(value) || (value as number) < 0) problems.push(`${name} must be a non-negative integer`);
  }
  return problems;
}
