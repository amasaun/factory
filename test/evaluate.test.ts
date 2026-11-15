import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { extractTask, renderTask } from "../src/control/issue-task.ts";
import { type Task, taskProblems } from "../src/control/task.ts";
import { fullTask, scores } from "./helpers.ts";
import { parseConfig } from "../src/run/config.ts";
import { AREAS, EVALUATION_SCHEMA, evaluateTicket, evaluationComment, evaluationPrompt, failsWithoutModel, ticketGaps } from "../src/run/evaluate.ts";

const T = { minMean: 4.5, minArea: 4 };

test("a complete ticket has no gaps and is valid", () => {
  assert.deepEqual(taskProblems(fullTask()), []);
  assert.ok(Object.values(ticketGaps(fullTask(), "acme/app")).every((g) => g.length === 0));
  assert.equal(failsWithoutModel(fullTask(), "acme/app"), false);
});

test("each missing piece is reported under its own area", () => {
  const gaps = (change: (t: Task) => void) => {
    const t = fullTask();
    change(t);
    return ticketGaps(t, "acme/app");
  };
  assert.match(gaps((t) => delete t.summary).description[0]!, /no short description/);
  assert.match(gaps((t) => (t.summary = "x".repeat(601))).description[0]!, /longer than/);
  assert.match(gaps((t) => delete t.story).story[0]!, /no user story/);
  assert.match(gaps((t) => delete t.acceptance[1]!.gherkin).acceptance[0]!, /AC-2/);
  // Given / When / Then must all be there, in that order.
  assert.match(gaps((t) => (t.acceptance[0]!.gherkin = "Then it works when given input")).acceptance[0]!, /AC-1/);
  assert.match(gaps((t) => (t.acceptance[0]!.gherkin = "When truncated then 'abc'")).acceptance[0]!, /AC-1/);
  assert.match(gaps((t) => delete t.testCases).testCases[0]!, /no test cases/);
  assert.match(gaps((t) => t.testCases!.pop()).testCases[0]!, /no test case covers: AC-2/);
  assert.match(gaps((t) => delete t.repository).repository[0]!, /does not name its repository/);
  assert.match(gaps((t) => (t.repository = "olivo/web")).repository[0]!, /is for olivo\/web, but this is acme\/app/);
  assert.match(gaps((t) => delete t.impactedAreas).impact[0]!, /not stated/);
  // An explicit empty list is a statement, not a gap; its plausibility is for the scorer.
  assert.deepEqual(gaps((t) => (t.impactedAreas = [])).impact, []);
  assert.deepEqual(ticketGaps(fullTask(), "ACME/App").repository, []);
});

test("a ticket passes with an average of 4.5 and nothing below 4", () => {
  assert.equal(evaluateTicket(fullTask(), "acme/app", scores(5), T).passed, true);
  const mixed = evaluateTicket(fullTask(), "acme/app", scores(5, { story: 4, impact: 4 }), T);
  assert.equal(mixed.mean, 4.71);
  assert.equal(mixed.passed, true);
  // 4.43 average: below the bar even though nothing is under 4.
  const low = evaluateTicket(fullTask(), "acme/app", scores(4, { description: 5, story: 5, acceptance: 5 }), T);
  assert.equal(low.mean, 4.43);
  assert.equal(low.passed, false);
  // A high average does not excuse one weak area.
  const weak = evaluateTicket(fullTask(), "acme/app", scores(5, { testCases: 3.5 }), T);
  assert.equal(weak.mean, 4.79);
  assert.equal(weak.lowest, 3.5);
  assert.equal(weak.passed, false);
  assert.equal(evaluateTicket(fullTask(), "acme/app", scores(4.5), T).passed, true);
});

test("a missing piece fails its area whatever the scorer says", () => {
  const t = fullTask();
  delete t.testCases;
  const e = evaluateTicket(t, "acme/app", scores(5), T);
  assert.equal(e.areas.testCases.score, 1);
  assert.match(e.areas.testCases.reason, /no test cases/);
  assert.equal(e.passed, false);
  assert.equal(failsWithoutModel(t, "acme/app"), true);
});

test("unusable scorer output scores the minimum and never passes", () => {
  for (const junk of [null, undefined, "5", [], {}, { scores: null }, { scores: {} }, { scores: { description: 5 } }]) {
    assert.equal(evaluateTicket(fullTask(), "acme/app", junk, T).passed, false);
  }
  for (const bad of [0, 6, -1, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
    const out = scores(5);
    (out.scores.readiness as { score: unknown }).score = bad;
    const e = evaluateTicket(fullTask(), "acme/app", out, T);
    assert.equal(e.areas.readiness.score, 1, String(bad));
    assert.equal(e.passed, false);
  }
});

test("the comment for the ticket shows every area and neutralises markup in reasons", () => {
  const out = scores(5);
  out.scores.story!.reason = "ok | <img src=x> [link](http://evil.example) `code` @someone";
  const text = evaluationComment(evaluateTicket(fullTask(), "acme/app", out, T), { passed: "Passed.", failed: "Failed." });
  assert.ok(text.startsWith("Passed."));
  assert.equal(text.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Area") && !l.startsWith("|---")).length, AREAS.length);
  const row = text.split("\n").find((l) => l.startsWith("| User story"))!;
  assert.ok(!/[<>`\[\]]/.test(row.split("|")[3]!));
  assert.ok(!row.includes("@someone"));
  assert.ok(text.includes("Average 5, lowest 5."));
  const t = fullTask();
  delete t.story;
  assert.ok(evaluationComment(evaluateTicket(t, "acme/app", scores(5), T), { passed: "Passed.", failed: "Failed." }).startsWith("Failed."));
});

test("the evaluation prompt delimits the ticket and covers every scored area", () => {
  const template = readFileSync(new URL("../prompts/evaluate.md", import.meta.url), "utf8");
  const p = evaluationPrompt(template, fullTask(), "n0nce");
  assert.ok(p.includes("TICKET-BEGIN n0nce"));
  assert.ok(p.includes("TICKET-END n0nce"));
  assert.ok(p.includes('"summary": "Add a truncate helper'));
  assert.ok(!p.includes("{{"));
  for (const area of AREAS) assert.ok(template.includes(`\`${area}\``), area);
  assert.deepEqual([...EVALUATION_SCHEMA.properties.scores.required], [...AREAS]);
  const t = fullTask();
  t.summary = "contains n0nce";
  assert.throws(() => evaluationPrompt(template, t, "n0nce"), /nonce/);
});

test("a ticket body is readable and reads back to the same task", () => {
  const body = renderTask(fullTask());
  assert.ok(body.startsWith("Add a truncate helper"));
  assert.ok(body.includes("As a user browsing a list, I want long titles shortened with an ellipsis, so that rows stay on one line and remain readable."));
  assert.ok(body.includes("```gherkin\nGiven the text 'abc'\nWhen it is truncated to 4\nThen the result is 'abc'\n```"));
  assert.ok(body.includes("- **T-2** (AC-2):"));
  assert.ok(body.includes("`acme/app`"));
  assert.ok(body.includes("- **List views:**"));
  assert.deepEqual(extractTask(body), { ok: true, task: fullTask() });
  assert.deepEqual(extractTask(`Some intro written by a person.\n\n${body}\n\nA trailing note.`), { ok: true, task: fullTask() });
  const none = fullTask();
  none.impactedAreas = [];
  assert.ok(renderTask(none).includes("None identified."));
});

test("malformed new fields are reported", () => {
  const bad = (change: (t: Record<string, unknown>) => void) => {
    const t = fullTask() as unknown as Record<string, unknown>;
    change(t);
    return taskProblems(t).join(" | ");
  };
  assert.match(bad((t) => (t.summary = "")), /summary/);
  assert.match(bad((t) => (t.story = { role: "x" })), /story needs/);
  assert.match(bad((t) => (t.repository = "not a repo")), /repository must be owner\/name/);
  assert.match(bad((t) => (t.impactedAreas = ["billing"])), /impactedAreas/);
  assert.match(bad((t) => (t.testCases = [{ id: "T-1", description: "x", covers: ["AC-9"] }])), /unknown criterion 'AC-9'/);
  assert.match(bad((t) => ((t.acceptance as { gherkin: unknown }[])[0]!.gherkin = "")), /gherkin/);
});

test("evaluation settings come from repository policy", () => {
  const ok = { version: 1, baseBranch: "main", approvers: ["owner"], commands: { setup: [], test: [["node", "--test"]] } };
  const d = parseConfig(JSON.stringify(ok));
  assert.deepEqual(d.evaluation, { model: "sonnet", minScore: 4.5, minAreaScore: 4, usd: 0.25 });
  assert.equal(d.runsPerDay, 10);
  assert.equal(d.triggerLabel, "factory");
  const c = parseConfig(JSON.stringify({ ...ok, triggerLabel: "ai-ready", evaluation: { model: "haiku", minScore: 4 }, budget: { runsPerDay: 3 } }));
  assert.equal(c.evaluation.model, "haiku");
  assert.equal(c.evaluation.minScore, 4);
  assert.equal(c.runsPerDay, 3);
  assert.equal(c.triggerLabel, "ai-ready");
  assert.throws(() => parseConfig(JSON.stringify({ ...ok, evaluation: { minScore: 6 } })), /minScore/);
  assert.throws(() => parseConfig(JSON.stringify({ ...ok, evaluation: { model: "son net" } })), /evaluation.model/);
  assert.throws(() => parseConfig(JSON.stringify({ ...ok, budget: { runsPerDay: 0 } })), /runsPerDay/);
  assert.throws(() => parseConfig(JSON.stringify({ ...ok, triggerLabel: "" })), /triggerLabel/);
});
