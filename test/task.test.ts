import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalize, digest } from "../src/control/digest.ts";
import { type Task, REQUIRED_TASK_FIELDS, approvalProblems, approve, taskProblems } from "../src/control/task.ts";

const task = (): Task => ({
  goal: "Reject empty usernames at signup so blank accounts stop appearing.",
  acceptance: [{ id: "AC-1", behavior: "POST /signup with an empty username returns 422", evidence: "scenario" }],
  scenarios: { digest: `sha256:${"a".repeat(64)}` },
  nonGoals: ["Changing password rules"],
  scope: { components: ["signup"], permitted: ["src/signup/**"], forbidden: ["src/billing/**"] },
  risk: { level: "low", concerns: [] },
});

const details = {
  policyDigest: digest({ base: "main" }),
  repository: "example/app",
  approver: "owner",
  approvedAt: "2026-11-14T00:00:00Z",
};
const current = () => ({ task: task(), policyDigest: details.policyDigest, repository: "example/app", approvers: ["owner"] });

test("digests ignore key order and whitespace but not content", () => {
  assert.equal(digest({ a: 1, b: [1, { c: 2, d: 3 }] }), digest({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.equal(canonicalize({ b: undefined, a: "x" }), '{"a":"x"}');
  assert.throws(() => canonicalize({ a: Number.NaN }), TypeError);
});

test("a well-formed task has no problems", () => {
  assert.deepEqual(taskProblems(task()), []);
  assert.deepEqual(taskProblems({ ...task(), scenarios: { omitted: "documentation-only change" } }), []);
});

test("malformed tasks are reported field by field", () => {
  assert.deepEqual(taskProblems("nope"), ["task must be an object"]);
  assert.equal(taskProblems({}).length, REQUIRED_TASK_FIELDS.length);
  const dup = { ...task(), acceptance: [task().acceptance[0], task().acceptance[0]] };
  assert.ok(taskProblems(dup).some((p) => p.includes("duplicate criterion id")));
  assert.ok(taskProblems({ ...task(), acceptance: [] }).some((p) => p.includes("at least one")));
  assert.ok(taskProblems({ ...task(), scenarios: { digest: "abc" } }).some((p) => p.includes("scenarios")));
  assert.ok(taskProblems({ ...task(), risk: { level: "extreme", concerns: [] } }).some((p) => p.includes("risk")));
});

test("an approval is valid for the exact task, policy, repository and approver", () => {
  const approval = approve(task(), details);
  assert.deepEqual(approvalProblems(approval, current()), []);
});

test("editing the task after approval voids the approval", () => {
  const approval = approve(task(), details);
  const edited = { ...task(), scope: { ...task().scope, permitted: ["src/**"] } };
  assert.deepEqual(approvalProblems(approval, { ...current(), task: edited }), ["task changed after approval"]);
});

test("an approval does not transfer to another policy, repository or approver", () => {
  const approval = approve(task(), details);
  assert.deepEqual(approvalProblems(approval, { ...current(), policyDigest: digest({ base: "dev" }) }), [
    "policy changed after approval",
  ]);
  assert.deepEqual(approvalProblems(approval, { ...current(), repository: "example/other" }), [
    "approval is for a different repository",
  ]);
  assert.deepEqual(approvalProblems(approval, { ...current(), approvers: ["someone-else"] }), [
    "'owner' is not an approver",
  ]);
});

test("a malformed task cannot be approved", () => {
  assert.throws(() => approve({ ...task(), goal: "" }, details), /malformed task/);
});

test("the JSON schema requires the same fields as the validator", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/task.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...schema.required].sort(), [...REQUIRED_TASK_FIELDS].sort());
});
