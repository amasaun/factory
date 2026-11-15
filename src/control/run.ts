/**
 * Run state as a pure fold over the event log (docs/spec.md §3, §9, §11, §13).
 * `applyEvent` is the only place a run changes, so every rule about leases,
 * candidate identity and budgets is enforced here.
 */
import {
  type Limits,
  type Phase,
  type Usage,
  BudgetError,
  DEFAULT_LIMITS,
  consume,
  consumeInfraRetry,
  denyReason,
  emptyUsage,
  grantFeedbackRound,
} from "./budget.ts";
import { type State, type Trigger, ACTIVE, TRANSITIONS, TRIGGERS, TransitionError, nextState } from "./states.ts";

export const ACCOUNTING_EVENTS = ["lease-issued", "builder-invoked", "judge-invoked", "infra-retry"] as const;
export type AccountingEvent = (typeof ACCOUNTING_EVENTS)[number];
export type EventType = Trigger | AccountingEvent;

export interface FactoryEvent {
  type: EventType;
  /** Why this happened. Every event records its cause. */
  cause: string;
  /** Lease generation of the worker reporting this result. */
  lease?: number;
  /** Candidate commit this event produces or refers to. */
  candidate?: string;
  /** Destination chosen by a human decision. */
  target?: State;
  /** Destinations a human may choose when the run enters `needs-human`. */
  resumeTargets?: State[];
  phase?: Phase;
}

export interface HistoryEntry {
  seq: number;
  type: EventType;
  from: State;
  to: State;
  cause: string;
}

export interface RunState {
  taskId: string;
  state: State;
  /** Number of events applied. */
  seq: number;
  leaseGeneration: number;
  candidate: string | null;
  hasBranch: boolean;
  hasPullRequest: boolean;
  resumeTargets: State[];
  limits: Limits;
  usage: Usage;
  history: HistoryEntry[];
}

export class StaleLeaseError extends Error {
  override name = "StaleLeaseError";
}
export class StaleEvidenceError extends Error {
  override name = "StaleEvidenceError";
}

export function newRun(taskId: string, limits: Limits = DEFAULT_LIMITS): RunState {
  return {
    taskId,
    state: "draft",
    seq: 0,
    leaseGeneration: 0,
    candidate: null,
    hasBranch: false,
    hasPullRequest: false,
    resumeTargets: [],
    limits,
    usage: emptyUsage(),
    history: [],
  };
}

/** Results reported by a worker. They are only accepted from the current lease. */
const WORKER_RESULTS: ReadonlySet<EventType> = new Set([
  "environment-ready",
  "baseline-accepted",
  "baseline-unclassified",
  "candidate-bundled",
  "verification-passed",
  "judge-accepted",
  "judge-inconclusive",
  "builder-invoked",
  "judge-invoked",
]);

/** Events that are statements about one specific candidate. */
const CANDIDATE_BOUND: ReadonlySet<EventType> = new Set([
  "verifier-provisioned",
  "verification-passed",
  "actionable-failure",
  "judge-accepted",
  "judge-inconclusive",
  "published",
  "ci-passed",
]);

/** Events that introduce a new candidate commit. */
const CANDIDATE_SETTING: ReadonlySet<EventType> = new Set([
  "candidate-bundled",
  "carried-forward",
  "refresh-succeeded",
  "adopt",
]);

const BUILDER_PHASE_STATES: Record<Phase, State> = {
  initial: "building",
  repair: "repairing",
  ci: "repairing",
  feedback: "repairing",
  refresh: "stale",
};

function requireLease(run: RunState, event: FactoryEvent): void {
  if (event.lease === undefined) throw new StaleLeaseError(`'${event.type}' must carry a lease generation`);
  if (event.lease !== run.leaseGeneration) {
    throw new StaleLeaseError(
      `'${event.type}' from lease ${event.lease} rejected; current lease is ${run.leaseGeneration}`,
    );
  }
}

function applyAccounting(run: RunState, event: FactoryEvent): RunState {
  switch (event.type as AccountingEvent) {
    case "lease-issued":
      if (!ACTIVE.includes(run.state)) throw new TransitionError(`no lease can be issued in state '${run.state}'`);
      return { ...run, leaseGeneration: run.leaseGeneration + 1 };
    case "infra-retry":
      return { ...run, usage: consumeInfraRetry(run.limits, run.usage) };
    case "builder-invoked": {
      const phase = event.phase;
      if (!phase) throw new TransitionError("'builder-invoked' must name a phase");
      if (run.state !== BUILDER_PHASE_STATES[phase]) {
        throw new TransitionError(`builder cannot run phase '${phase}' in state '${run.state}'`);
      }
      return { ...run, usage: consume(run.limits, run.usage, "builder", phase) };
    }
    case "judge-invoked": {
      const phase = event.phase;
      if (!phase) throw new TransitionError("'judge-invoked' must name a phase");
      const expected: State = phase === "refresh" ? "stale" : "judging";
      if (run.state !== expected) {
        throw new TransitionError(`judge cannot run phase '${phase}' in state '${run.state}'`);
      }
      return { ...run, usage: consume(run.limits, run.usage, "judge", phase) };
    }
  }
}

export function applyEvent(run: RunState, event: FactoryEvent): RunState {
  if (!event.cause?.trim()) throw new TransitionError(`'${event.type}' must record a cause`);

  const fromCi = event.type === "actionable-failure" && run.state === "ci-pending";
  if (WORKER_RESULTS.has(event.type) || (event.type === "actionable-failure" && !fromCi)) {
    requireLease(run, event);
  }

  const record = (next: RunState): RunState => ({
    ...next,
    seq: run.seq + 1,
    history: [
      ...run.history,
      { seq: run.seq + 1, type: event.type, from: run.state, to: next.state, cause: event.cause },
    ],
  });

  if ((ACCOUNTING_EVENTS as readonly string[]).includes(event.type)) {
    return record(applyAccounting(run, event));
  }
  if (!(TRIGGERS as readonly string[]).includes(event.type)) {
    throw new TransitionError(`unknown event type '${event.type}'`);
  }
  const trigger = event.type as Trigger;

  if (CANDIDATE_BOUND.has(trigger)) {
    if (!event.candidate || event.candidate !== run.candidate) {
      throw new StaleEvidenceError(
        `'${trigger}' refers to candidate ${event.candidate ?? "(none)"}; current candidate is ${run.candidate ?? "(none)"}`,
      );
    }
  }

  const to = nextState(run.state, trigger, {
    hasBranch: run.hasBranch,
    hasPullRequest: run.hasPullRequest,
    target: event.target,
    resumeTargets: run.resumeTargets,
  });

  let next: RunState = { ...run, state: to };

  if (CANDIDATE_SETTING.has(trigger)) {
    if (!event.candidate) throw new TransitionError(`'${trigger}' must name the candidate commit`);
    if (trigger !== "adopt" && event.candidate === run.candidate) {
      throw new TransitionError(`'${trigger}' did not produce a new candidate`);
    }
    next.candidate = event.candidate;
  }

  switch (trigger) {
    case "admitted":
      next.hasBranch = true;
      break;
    case "published":
      next.hasPullRequest = true;
      break;
    case "actionable-failure": {
      const phase: Phase = fromCi ? "ci" : "repair";
      if (event.phase && event.phase !== phase) {
        throw new TransitionError(`a failure in '${run.state}' is a '${phase}' repair, not '${event.phase}'`);
      }
      const reason = denyReason(run.limits, run.usage, "builder", phase);
      if (reason) throw new BudgetError(`no repair possible: ${reason}`);
      break;
    }
    case "feedback-in-scope":
      next.usage = grantFeedbackRound(run.limits, run.usage);
      break;
    case "human-decision":
      next.resumeTargets = [];
      break;
  }

  if (to === "needs-human") {
    const targets = event.resumeTargets ?? [];
    if (targets.length === 0) {
      throw new TransitionError(`'${trigger}' must list the states a human decision may resume into`);
    }
    for (const t of targets) {
      if (!ACTIVE.includes(t) || t === "needs-human") {
        throw new TransitionError(`'${t}' is not a valid resume target`);
      }
    }
    next.resumeTargets = [...targets];
  }

  return record(next);
}

export function replay(taskId: string, events: readonly FactoryEvent[], limits: Limits = DEFAULT_LIMITS): RunState {
  return events.reduce(applyEvent, newRun(taskId, limits));
}

/** Triggers currently allowed by the table alone, for status display. */
export function allowedTriggers(run: RunState): Trigger[] {
  return TRIGGERS.filter((t) => {
    const rule = TRANSITIONS[t];
    if (!rule.from.includes(run.state)) return false;
    if (rule.requires === "branch") return run.hasBranch;
    if (rule.requires === "pull-request") return run.hasPullRequest;
    return true;
  });
}
