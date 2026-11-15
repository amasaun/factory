/** Run states and the transition table from docs/spec.md §9. */

export const STATES = [
  "draft",
  "approved",
  "waiting-for-dependency",
  "queued",
  "provisioning",
  "baseline",
  "building",
  "candidate-frozen",
  "verifying",
  "judging",
  "repairing",
  "publishing",
  "ci-pending",
  "ready",
  "changes-requested",
  "stale",
  "needs-human",
  "handed-off",
  "merged",
  "cancelled",
  "failed",
] as const;
export type State = (typeof STATES)[number];

export const TERMINAL: ReadonlySet<State> = new Set(["merged", "cancelled", "failed"]);

/** States in which the factory may still act. `handed-off` only accepts `adopt`. */
export const ACTIVE: readonly State[] = STATES.filter((s) => !TERMINAL.has(s) && s !== "handed-off");

export const TRIGGERS = [
  "approval-verified",
  "admitted",
  "dependency-unmet",
  "dependency-merged",
  "capacity-granted",
  "environment-ready",
  "infra-exhausted",
  "baseline-accepted",
  "baseline-unclassified",
  "candidate-bundled",
  "verifier-provisioned",
  "verification-passed",
  "actionable-failure",
  "judge-accepted",
  "judge-inconclusive",
  "published",
  "ci-passed",
  "changes-requested",
  "feedback-in-scope",
  "feedback-out-of-scope",
  "base-moved-stale",
  "carried-forward",
  "refresh-succeeded",
  "refresh-blocked",
  "pr-merged",
  "pr-closed",
  "foreign-commit",
  "budget-exhausted",
  "cancel-authorized",
  "human-decision",
  "decision-timeout",
  "control-error",
  "adopt",
] as const;
export type Trigger = (typeof TRIGGERS)[number];

export interface Rule {
  from: readonly State[];
  /** `named` means the destination comes from the escalation's resume targets. */
  to: State | "named";
  requires?: "branch" | "pull-request";
}

export const TRANSITIONS: Readonly<Record<Trigger, Rule>> = {
  "approval-verified": { from: ["draft"], to: "approved" },
  admitted: { from: ["approved"], to: "queued" },
  "dependency-unmet": { from: ["approved"], to: "waiting-for-dependency" },
  "dependency-merged": { from: ["waiting-for-dependency"], to: "approved" },
  "capacity-granted": { from: ["queued"], to: "provisioning" },
  "environment-ready": { from: ["provisioning"], to: "baseline" },
  "infra-exhausted": { from: ["provisioning"], to: "needs-human" },
  "baseline-accepted": { from: ["baseline"], to: "building" },
  "baseline-unclassified": { from: ["baseline"], to: "needs-human" },
  "candidate-bundled": { from: ["building", "repairing"], to: "candidate-frozen" },
  "verifier-provisioned": { from: ["candidate-frozen"], to: "verifying" },
  "verification-passed": { from: ["verifying"], to: "judging" },
  "actionable-failure": { from: ["verifying", "judging", "ci-pending"], to: "repairing" },
  "judge-accepted": { from: ["judging"], to: "publishing" },
  "judge-inconclusive": { from: ["judging"], to: "needs-human" },
  published: { from: ["publishing"], to: "ci-pending" },
  "ci-passed": { from: ["ci-pending"], to: "ready" },
  "changes-requested": { from: ["ready"], to: "changes-requested" },
  "feedback-in-scope": { from: ["changes-requested"], to: "repairing" },
  "feedback-out-of-scope": { from: ["changes-requested"], to: "needs-human" },
  "base-moved-stale": { from: ["ready"], to: "stale" },
  "carried-forward": { from: ["ready"], to: "ready" },
  "refresh-succeeded": { from: ["stale"], to: "ready" },
  "refresh-blocked": { from: ["stale"], to: "needs-human" },
  "pr-merged": { from: ["ready"], to: "merged" },
  "pr-closed": { from: ACTIVE, to: "cancelled", requires: "pull-request" },
  "foreign-commit": { from: ACTIVE, to: "handed-off", requires: "branch" },
  "budget-exhausted": { from: ACTIVE.filter((s) => s !== "needs-human"), to: "needs-human" },
  "cancel-authorized": { from: ACTIVE, to: "cancelled" },
  "human-decision": { from: ["needs-human"], to: "named" },
  "decision-timeout": { from: ["needs-human"], to: "cancelled" },
  "control-error": { from: ACTIVE, to: "failed" },
  adopt: { from: ["handed-off"], to: "candidate-frozen" },
};

export class TransitionError extends Error {
  override name = "TransitionError";
}

export interface TransitionContext {
  hasBranch: boolean;
  hasPullRequest: boolean;
  /** Destination requested by a human decision. */
  target?: State;
  /** Destinations the pending escalation allows. */
  resumeTargets?: readonly State[];
}

export function nextState(state: State, trigger: Trigger, ctx: TransitionContext): State {
  const rule = TRANSITIONS[trigger];
  if (!rule.from.includes(state)) {
    throw new TransitionError(`'${trigger}' is not allowed in state '${state}'`);
  }
  if (rule.requires === "branch" && !ctx.hasBranch) {
    throw new TransitionError(`'${trigger}' requires a factory branch`);
  }
  if (rule.requires === "pull-request" && !ctx.hasPullRequest) {
    throw new TransitionError(`'${trigger}' requires a pull request`);
  }
  if (rule.to !== "named") return rule.to;
  if (!ctx.target || !ctx.resumeTargets?.includes(ctx.target)) {
    throw new TransitionError(
      `'${trigger}' must name one of the escalation's resume targets: ${ctx.resumeTargets?.join(", ") || "(none)"}`,
    );
  }
  return ctx.target;
}
