/**
 * The task contract as it appears in a task issue (docs/spec.md §3, §7): one
 * marker line followed by one fenced JSON block. Everything else in the issue
 * body is free text for people and has no effect.
 */
import { type Task, taskProblems } from "./task.ts";

export const TASK_MARKER = "<!-- factory-task:v1 -->";

export function renderTask(task: Task): string {
  return `${TASK_MARKER}\n\`\`\`json\n${JSON.stringify(task, null, 2)}\n\`\`\`\n`;
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
