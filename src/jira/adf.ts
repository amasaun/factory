/**
 * Jira stores ticket descriptions and comments in the Atlassian Document
 * Format (ADF), a JSON tree. This reads a task out of a description and writes
 * the factory's comments.
 */
import { type Task, taskProblems } from "../control/task.ts";

/** The line that marks the task data in a Jira description. Plain text, because ADF has no comments. */
export const JIRA_TASK_MARKER = "factory-task:v1";

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

/** All text under a node, in order. */
export function adfText(node: AdfNode | null | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(adfText).join("");
}

/** Block-level nodes in document order, looking inside containers such as expands, panels and quotes. */
function blocks(node: AdfNode, out: AdfNode[] = []): AdfNode[] {
  for (const child of node.content ?? []) {
    if (child.type === "paragraph" || child.type === "codeBlock" || child.type === "heading") out.push(child);
    else blocks(child, out);
  }
  return out;
}

export type ExtractedTask = { ok: true; task: Task } | { ok: false; problems: string[] };

/**
 * The task in a Jira description: a paragraph containing the marker, followed
 * by a code block holding the task as JSON. Everything else in the description
 * is for people and has no effect.
 */
export function extractTaskFromAdf(description: unknown): ExtractedTask {
  if (typeof description !== "object" || description === null) return { ok: false, problems: ["the ticket has no description"] };
  const list = blocks(description as AdfNode);
  const markers = list.map((n, i) => (n.type !== "codeBlock" && adfText(n).includes(JIRA_TASK_MARKER) ? i : -1)).filter((i) => i >= 0);
  if (markers.length === 0) return { ok: false, problems: [`the ticket has no factory task: no line containing '${JIRA_TASK_MARKER}'`] };
  if (markers.length > 1) return { ok: false, problems: ["the ticket has more than one factory task marker"] };
  const next = list[markers[0]! + 1];
  if (!next || next.type !== "codeBlock") return { ok: false, problems: ["the task marker must be followed directly by a code block holding the task"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(adfText(next));
  } catch (e) {
    return { ok: false, problems: [`task JSON does not parse: ${(e as Error).message}`] };
  }
  const problems = taskProblems(parsed);
  return problems.length ? { ok: false, problems } : { ok: true, task: parsed as Task };
}

const text = (t: string, strong = false): AdfNode => ({ type: "text", text: t, ...(strong ? { marks: [{ type: "strong" }] } : {}) }) as AdfNode;
const paragraph = (...parts: (string | AdfNode)[]): AdfNode => ({
  type: "paragraph",
  content: parts.filter((p) => p !== "").map((p) => (typeof p === "string" ? text(p) : p)),
});

/** A comment as ADF: paragraphs, with an optional list of labelled lines. Text is inserted as text, never as markup. */
export function adfComment(paragraphs: string[], items: { label: string; value: string }[] = []): AdfNode {
  const content: AdfNode[] = paragraphs.filter((p) => p.trim()).map((p) => paragraph(p));
  if (items.length) {
    content.push({
      type: "bulletList",
      content: items.map((i) => ({ type: "listItem", content: [paragraph(text(`${i.label}: `, true), i.value)] })),
    });
  }
  return { type: "doc", attrs: { version: 1 }, content } as AdfNode;
}

/**
 * A ticket description as Markdown for tools that write to Jira from Markdown:
 * the task written out for people, then the marker line and the task data.
 * No HTML, because Jira would drop it.
 */
export function renderTaskForJira(task: Task): string {
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
    "## Task data",
    "",
    "The factory reads the block below. The text above is generated from it, so change the task here, not above.",
    "",
    JIRA_TASK_MARKER,
    "",
    "```json",
    JSON.stringify(task, null, 2),
    "```",
    "",
  );
  return lines.join("\n");
}
