import { type FactoryEvent, type RunState, applyEvent, newRun } from "../src/control/run.ts";
import type { Task } from "../src/control/task.ts";
import { AREAS } from "../src/run/evaluate.ts";

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

/** A ticket with everything the ticket evaluation looks for, for the repository acme/app. */
export const fullTask = (): Task => ({
  summary: "Add a truncate helper so long titles fit in list views.",
  story: { role: "a user browsing a list", want: "long titles shortened with an ellipsis", benefit: "rows stay on one line and remain readable" },
  repository: "acme/app",
  impactedAreas: [{ area: "List views", impact: "Titles longer than the limit are now shortened." }],
  goal: "Add truncate(text, max) to the text utilities.",
  acceptance: [
    { id: "AC-1", behavior: "Short text is unchanged.", evidence: "unit test", gherkin: "Given the text 'abc'\nWhen it is truncated to 4\nThen the result is 'abc'" },
    { id: "AC-2", behavior: "Long text is cut with an ellipsis.", evidence: "unit test", gherkin: "Given the text 'abcdef'\nWhen it is truncated to 4\nThen the result is 'abc…'" },
  ],
  testCases: [
    { id: "T-1", description: "truncate('abc', 4) returns 'abc'", covers: ["AC-1"] },
    { id: "T-2", description: "truncate('abcdef', 4) returns 'abc…' and has length 4", covers: ["AC-2"] },
  ],
  scenarios: { omitted: "not implemented yet" },
  nonGoals: ["Word-aware truncation"],
  scope: { components: ["text"], permitted: ["src/truncate.js", "test/truncate.test.js"], forbidden: [] },
  risk: { level: "low", concerns: [] },
});
export const scores = (value: number, over: Record<string, number> = {}) => ({
  scores: Object.fromEntries(AREAS.map((a) => [a, { score: over[a] ?? value, reason: `${a} looks fine` }])),
});
