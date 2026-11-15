/**
 * The task contract as it appears in a task issue (docs/spec.md §3, §7): one
 * marker line followed by one fenced JSON block. Everything else in the issue
 * body is free text for people and has no effect.
 */
import { type Task, taskProblems } from "./task.ts";

export const TASK_MARKER = "<!-- factory-task:v1 -->";

/** The machine-readable block alone. This is what the factory reads. */
export function renderTaskBlock(task: Task): string {
  return `${TASK_MARKER}\n\`\`\`json\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`;
}

/**
 * A ticket body: the task written out for people, followed by the block the
 * factory reads. The readable part is generated from the block, so the two
 * cannot disagree as long as changes are made to the block.
 */
export function renderTask(task: Task): string {
  const lines: string[] = [];
  if (task.summary) lines.push(task.summary, "");
  if (task.story) lines.push("## Why", "", `As ${task.story.role}, I want ${task.story.want}, so that ${task.story.benefit}.`, "");
  lines.push("## Acceptance criteria", "");
  for (const c of task.acceptance) {
    lines.push(`**${c.id}.** ${c.behavior}`, "");
    if (c.gherkin) lines.push("```gherkin", c.gherkin.trim(), "```", "");
  }
  if (task.testCases?.length) {
    lines.push("## Test cases", "");
    for (const t of task.testCases) lines.push(`- **${t.id}** (${t.covers.join(", ")}): ${t.description}`);
    lines.push("");
  }
  if (task.repository) lines.push("## Repository", "", `\`${task.repository}\``, "");
  if (task.impactedAreas) {
    lines.push("## Other areas affected", "");
    if (task.impactedAreas.length === 0) lines.push("None identified.");
    for (const a of task.impactedAreas) lines.push(`- **${a.area}:** ${a.impact}`);
    lines.push("");
  }
  if (task.nonGoals.length) lines.push("## Not included", "", ...task.nonGoals.map((n) => `- ${n}`), "");
  lines.push(
    "---",
    "",
    "<details>",
    "<summary>Task data read by the factory. The text above is generated from it; change the task here, not above.</summary>",
    "",
    renderTaskBlock(task).trimEnd(),
    "",
    "</details>",
    "",
  );
  return lines.join("\n");
}

export type ExtractedTask = { ok: true; task: Task } | { ok: false; problems: string[] };

export function extractTask(issueBody: string): ExtractedTask {
  const body = issueBody.replace(/\r\n/g, "\n");
  const first = body.indexOf(TASK_MARKER);
  if (first < 0) return { ok: false, problems: ["issue has no factory task block"] };
  if (body.indexOf(TASK_MARKER, first + 1) >= 0) {
    return { ok: false, problems: ["issue has more than one factory task block"] };
  }
  const m = /^\n```json\n([\s\S]*?)\n```[ \t]*(?:\n|$)/.exec(body.slice(first + TASK_MARKER.length));
  if (!m) return { ok: false, problems: ["the task marker must be followed directly by a ```json block"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]!);
  } catch (e) {
    return { ok: false, problems: [`task JSON does not parse: ${(e as Error).message}`] };
  }
  const problems = taskProblems(parsed);
  return problems.length ? { ok: false, problems } : { ok: true, task: parsed as Task };
}
