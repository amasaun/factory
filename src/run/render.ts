/** Text the pipeline writes: prompts for the workers and the pull request body. */
import type { Task } from "../control/task.ts";
import type { Verdict } from "./verdict.ts";

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => values[key] ?? whole);

export const MAX_FEEDBACK_BYTES = 16_000;

/** Keep the end of long feedback: with test output, the failure summary is at the bottom. */
export function clipFeedback(text: string): string {
  const bytes = Buffer.from(text.replace(/\r/g, ""));
  if (bytes.length <= MAX_FEEDBACK_BYTES) return bytes.toString();
  return `[earlier output omitted]\n${bytes.subarray(bytes.length - MAX_FEEDBACK_BYTES).toString()}`;
}

export function builderPrompt(
  template: string,
  task: Task,
  testCommands: string[][],
  repair?: { attempt: number; feedback: string },
): string {
  const prompt = fill(template, {
    TASK: JSON.stringify(task, null, 2),
    TEST_COMMANDS: testCommands.map((c) => `- \`${c.join(" ")}\``).join("\n"),
  });
  if (!repair) return prompt;
  return [
    prompt,
    `## This is repair attempt ${repair.attempt}`,
    "",
    "Your previous attempt is already applied in the working tree. It was not accepted, for the reasons below. Fix exactly those problems with the smallest change that resolves them, keep everything that was already correct, and make sure the test commands pass. The same rules as above apply.",
    "",
    "Why the previous attempt was not accepted:",
    "",
    fenced(clipFeedback(repair.feedback) || "No details were recorded."),
    "",
  ].join("\n");
}

export const MAX_DIFF_BYTES = 300_000;

export function judgePrompt(template: string, task: Task, diff: string, nonce: string): string {
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) throw new Error(`diff is larger than ${MAX_DIFF_BYTES} bytes`);
  if (diff.includes(nonce)) throw new Error("diff contains the delimiter nonce");
  // Fill the nonce first so that nothing inside the diff can be mistaken for a placeholder afterwards.
  const head = fill(template, { NONCE: nonce, TASK: JSON.stringify(task, null, 2) });
  return head.replace("{{DIFF}}", () => diff);
}

/** Added to the builder's prompt when it takes over from a builder that was stopped for using too much context. */
export function handoffSection(handoff: number, workingTreeStatus: string): string {
  return [
    "",
    `## You are taking over from another agent (handoff ${handoff})`,
    "",
    "A previous agent was working on this task and was stopped because its working context had grown too large. Its changes so far are in the working tree, uncommitted. They may be incomplete or partly wrong. Do not start over: read the changed files listed below, work out what is done and what is missing against the acceptance criteria, then finish the task and make the test commands pass. Work efficiently and read only what you need.",
    "",
    "Files changed so far:",
    "",
    fenced(clipFeedback(workingTreeStatus) || "(no changes yet)"),
    "",
  ].join("\n");
}

/** Permission rules that let the builder run exactly the configured test commands. */
export function allowedBashRules(testCommands: string[][]): string[] {
  return testCommands.flatMap((c) => [`Bash(${c.join(" ")})`, `Bash(${c.join(" ")} *)`]);
}

/** Untrusted text shown verbatim, so it cannot render as markup, link or mention anyone. */
export function fenced(text: string): string {
  const safe = text.replace(/~{3,}/g, "~~").replace(/\r/g, "").trim();
  return `~~~text\n${safe}\n~~~`;
}

const oneLine = (text: string, max = 120): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function pullRequestTitle(task: Task): string {
  return oneLine(task.goal, 72);
}

export function pullRequestBody(e: {
  task: Task;
  issue: number;
  taskDigest: string;
  base: string;
  candidate: string;
  tree: string;
  changedPaths: string[];
  verdict: Verdict;
  testCommands: string[][];
  runUrl: string;
  /** Which attempt was accepted, counting from 1. */
  attempt: number;
  /** Markdown describing model usage for the run. */
  usage: string;
}): string {
  const criteria = e.task.acceptance
    .map((c) => {
      const v = e.verdict.criteria.find((x) => x.id === c.id);
      return `### ${c.id}: ${v?.result ?? "not judged"}\n\n${fenced(c.behavior)}\n\nJudge's reasoning:\n\n${fenced(v?.reasoning ?? "")}`;
    })
    .join("\n\n");
  const findings = e.verdict.findings.length
    ? e.verdict.findings.map((f) => `- **${f.severity}**\n\n${fenced(`${f.summary}${f.detail ? `\n${f.detail}` : ""}`)}`).join("\n")
    : "None.";
  return [
    `Task: #${e.issue}`,
    "",
    "## Intent",
    "",
    fenced(e.task.goal),
    "",
    "## Acceptance criteria",
    "",
    criteria,
    "",
    "## Checks",
    "",
    "- Scope and protected paths: passed at intake.",
    `- Tests on the base commit and on the candidate: passed (${e.testCommands.map((c) => `\`${c.join(" ")}\``).join(", ")}).`,
    "- Independent judge: accepted.",
    e.attempt === 1
      ? "- Accepted on the first attempt."
      : `- Accepted on attempt ${e.attempt}. Earlier attempts were sent back to the builder; the task issue's event log records why.`,
    "",
    "Not performed in this pipeline version: hidden acceptance scenarios, mutation testing, the revert-the-fix check, secret scanning, and network isolation of workers. CI on this pull request waits for a person, because it was opened with the workflow's own token: close and reopen the pull request to start it.",
    "",
    "## Findings",
    "",
    findings,
    "",
    "## Model usage",
    "",
    e.usage,
    "",
    "## Identity",
    "",
    `- Task digest: \`${e.taskDigest}\``,
    `- Base commit: \`${e.base}\``,
    `- Candidate commit: \`${e.candidate}\``,
    `- Candidate tree: \`${e.tree}\``,
    `- Changed paths: ${e.changedPaths.map((p) => `\`${p}\``).join(", ")}`,
    `- Run: ${e.runUrl}`,
    "",
    "This pull request was produced by an automated pipeline. A person decides whether to merge it.",
  ].join("\n");
}
