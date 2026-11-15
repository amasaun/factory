import assert from "node:assert/strict";
import { test } from "node:test";
import { TASK_MARKER, extractTask, renderTask } from "../src/control/issue-task.ts";
import type { Task } from "../src/control/task.ts";

const task: Task = {
  goal: "Add a truncate function so long titles can be shortened.",
  acceptance: [{ id: "AC-1", behavior: "truncate('abcdef', 4) returns 'abc…'", evidence: "unit test" }],
  scenarios: { omitted: "first end-to-end trial; scenarios not yet wired" },
  nonGoals: ["Word-aware truncation"],
  scope: { components: ["text utilities"], permitted: ["src/**", "test/**"], forbidden: [] },
  risk: { level: "low", concerns: [] },
};

test("a rendered task is read back unchanged, with free text around it", () => {
  const body = `Please add this.\n\n${renderTask(task)}\nThanks!`;
  assert.deepEqual(extractTask(body), { ok: true, task });
  assert.deepEqual(extractTask(body.replace(/\n/g, "\r\n")), { ok: true, task });
});

test("an issue without a task block, or with two, is refused", () => {
  assert.deepEqual(extractTask("just a bug report"), { ok: false, problems: ["issue has no factory task block"] });
  const twice = extractTask(renderTask(task) + renderTask(task));
  assert.deepEqual(twice, { ok: false, problems: ["issue has more than one factory task block"] });
});

test("the marker must be followed directly by a JSON block", () => {
  const r = extractTask(`${TASK_MARKER}\nsome text\n\`\`\`json\n{}\n\`\`\`\n`);
  assert.equal(r.ok, false);
});

test("unparseable or malformed task JSON is reported", () => {
  const broken = extractTask(`${TASK_MARKER}\n\`\`\`json\n{nope\n\`\`\`\n`);
  assert.ok(!broken.ok && broken.problems[0]?.startsWith("task JSON does not parse"));
  const incomplete = extractTask(`${TASK_MARKER}\n\`\`\`json\n{"goal":"x"}\n\`\`\`\n`);
  assert.ok(!incomplete.ok && incomplete.problems.length >= 5);
});
