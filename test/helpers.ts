import { type FactoryEvent, type RunState, applyEvent, newRun } from "../src/control/run.ts";

export const C1 = "1111111111111111111111111111111111111111";
export const C2 = "2222222222222222222222222222222222222222";
export const C3 = "3333333333333333333333333333333333333333";

export const ev = (type: FactoryEvent["type"], extra: Partial<FactoryEvent> = {}): FactoryEvent => ({
  type,
  cause: `test: ${type}`,
  ...extra,
});

export const run = (events: FactoryEvent[], from: RunState = newRun("42")): RunState =>
  events.reduce(applyEvent, from);

/** Events that take a new task to `verifying` with candidate C1 under lease 1. */
export const toVerifying = (): FactoryEvent[] => [
  ev("approval-verified"),
  ev("admitted"),
  ev("capacity-granted"),
  ev("lease-issued"),
  ev("environment-ready", { lease: 1 }),
  ev("baseline-accepted", { lease: 1 }),
  ev("builder-invoked", { lease: 1, phase: "initial" }),
  ev("candidate-bundled", { lease: 1, candidate: C1 }),
  ev("verifier-provisioned", { candidate: C1 }),
];

/** Continues from `verifying` to `ready` with candidate C1. */
export const verifyingToReady = (): FactoryEvent[] => [
  ev("verification-passed", { lease: 1, candidate: C1 }),
  ev("judge-invoked", { lease: 1, phase: "initial" }),
  ev("judge-accepted", { lease: 1, candidate: C1 }),
  ev("published", { candidate: C1 }),
  ev("ci-passed", { candidate: C1 }),
];

export const toReady = (): FactoryEvent[] => [...toVerifying(), ...verifyingToReady()];
