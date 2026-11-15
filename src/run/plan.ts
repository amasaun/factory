/**
 * Turns the outcome of one pipeline run into the events to record
 * (docs/spec.md §9, §13). A run is a baseline check followed by one or more
 * attempts. An attempt that fails for a reason the builder can act on is
 * followed by a repair attempt, up to the limit set in repository policy.
 */
import type { FactoryEvent } from "../control/run.ts";
import type { State } from "../control/states.ts";
import type { Decision } from "./verdict.ts";

export type StageResult = "success" | "failure" | "cancelled" | "skipped";

/** What one build-freeze-verify-judge attempt reported. */
export interface Attempt {
  /** Result of the builder job. */
  build: StageResult;
  /** True when the candidate's tree is identical to the previous attempt's. */
  unchanged?: boolean;
  /** False when intake refused the candidate for scope or protected-path violations. */
  freezeOk?: boolean;
  /** Candidate commit, present when intake accepted it. */
  candidate?: string;
  /** Whether the repository's checks passed on the candidate. Absent when verification did not run. */
  verifyPassed?: boolean;
  /** The pipeline's reading of the judge's verdict. Absent when the judge did not run or returned nothing usable. */
  decision?: Decision;
  reasons?: string[];
}

export interface Outcome {
  baseline: StageResult;
  /** Attempts that ran, in order. */
  attempts: Attempt[];
  /** 1 + the number of repair rounds policy allows. */
  maxAttempts: number;
  lease: number;
  runUrl: string;
}

export interface Plan {
  events: FactoryEvent[];
  /** Index into `attempts` of the accepted attempt, when the run may publish. */
  publishAttempt: number | null;
  summary: string;
}

/** Events recorded at admission, before any worker starts. */
export function admissionEvents(cause: { actor: string; taskDigest: string; base: string; runUrl: string }): FactoryEvent[] {
  return [
    { type: "approval-verified", cause: `run started by ${cause.actor} for task ${cause.taskDigest} (${cause.runUrl})` },
    { type: "admitted", cause: `base commit ${cause.base}` },
    { type: "capacity-granted", cause: "single run per task; concurrency group held" },
    { type: "lease-issued", cause: `workers of ${cause.runUrl}` },
  ];
}

/** Whether an attempt ended in a way a further builder attempt could fix. */
export function isRepairable(a: Attempt): boolean {
  if (a.build !== "success" || a.unchanged) return false;
  if (a.freezeOk === false) return true;
  if (a.verifyPassed === false) return true;
  return a.decision === "reject";
}

export function planEvents(o: Outcome): Plan {
  const { lease } = o;
  const at = ` (${o.runUrl})`;
  const events: FactoryEvent[] = [{ type: "environment-ready", lease, cause: `worker environment started${at}` }];
  const stop = (summary: string, ...last: FactoryEvent[]): Plan => ({
    events: [...events, ...last],
    publishAttempt: null,
    summary,
  });
  const fail = (summary: string): Plan => stop(summary, { type: "control-error", cause: `${summary}${at}` });
  const escalate = (summary: string, target: State): Plan =>
    stop(summary, { type: "budget-exhausted", cause: `${summary}${at}`, resumeTargets: [target] });

  if (o.baseline !== "success") {
    const summary = `baseline checks did not pass on the base commit (${o.baseline})`;
    return stop(summary, { type: "baseline-unclassified", lease, cause: summary + at, resumeTargets: ["building"] });
  }
  events.push({ type: "baseline-accepted", lease, cause: `required checks pass on the base commit${at}` });
  if (o.attempts.length === 0) return fail("no build attempt ran");

  /** `building` until a candidate has been frozen and then failed; `repairing` afterwards. */
  let state: "building" | "repairing" = "building";
  let judged = 0;

  for (const [i, a] of o.attempts.entries()) {
    const n = i + 1;
    const last = n >= o.maxAttempts;
    const more = i + 1 < o.attempts.length;
    const label = `attempt ${n}`;
    events.push({
      type: "builder-invoked",
      lease,
      phase: state === "building" ? "initial" : "repair",
      cause: `builder ran, ${label}${at}`,
    });

    if (a.build !== "success") return fail(`builder did not produce a candidate on ${label} (${a.build})`);
    if (a.unchanged) return fail(`${label} changed nothing compared with the previous attempt`);

    // What to do when this attempt failed in a way the builder could fix.
    const failed = (summary: string, record?: FactoryEvent): Plan | null => {
      if (last) return escalate(`${summary}; no repair attempts left`, state === "building" && !record ? "building" : "repairing");
      if (record) {
        events.push(record);
        state = "repairing";
      }
      if (!more) return fail(`${summary}; the next attempt did not run`);
      return null;
    };

    if (a.freezeOk !== true || !a.candidate) {
      if (a.freezeOk !== false) return fail(`intake did not complete on ${label}`);
      // No candidate was frozen, so the run stays where it is and the builder tries again.
      const end = failed(`candidate was refused at intake on ${label}`);
      if (end) return end;
      continue;
    }
    const candidate = a.candidate;
    events.push({ type: "candidate-bundled", lease, candidate, cause: `candidate passed intake, ${label}${at}` });
    events.push({ type: "verifier-provisioned", candidate, cause: `fresh verifier started, ${label}${at}` });

    if (a.verifyPassed !== true) {
      if (a.verifyPassed !== false) return fail(`verification did not complete on ${label}`);
      const summary = `verification failed on ${label}`;
      const end = failed(summary, { type: "actionable-failure", lease, candidate, phase: "repair", cause: summary + at });
      if (end) return end;
      continue;
    }
    events.push({ type: "verification-passed", lease, candidate, cause: `required checks pass on the candidate, ${label}${at}` });

    events.push({ type: "judge-invoked", lease, phase: judged++ === 0 ? "initial" : "repair", cause: `judge ran, ${label}${at}` });
    if (!a.decision) return fail(`judge did not return a verdict on ${label}`);
    const why = a.reasons?.length ? `: ${a.reasons.join("; ")}` : "";
    if (a.decision === "inconclusive") {
      const summary = `judge was inconclusive on ${label}${why}`;
      return stop(summary, { type: "judge-inconclusive", lease, candidate, cause: summary + at, resumeTargets: ["repairing"] });
    }
    if (a.decision === "reject") {
      const summary = `judge rejected ${label}${why}`;
      const end = failed(summary, { type: "actionable-failure", lease, candidate, phase: "repair", cause: summary + at });
      if (end) return end;
      continue;
    }
    events.push({ type: "judge-accepted", lease, candidate, cause: `every criterion met, no blocking findings, ${label}${at}` });
    return { events, publishAttempt: i, summary: `candidate verified and accepted on ${label}` };
  }
  return fail("the run ended without an outcome");
}
