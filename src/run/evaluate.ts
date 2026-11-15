/**
 * The ticket evaluation: a quick check, before anything is built, that a task
 * says enough to be built well. A task that does not pass is not started.
 *
 * Two layers. Plain checks catch what is missing or malformed, and a model
 * scores the quality of what is there. A plain check that fails fixes that
 * area's score at the minimum, so the model cannot argue past it.
 */
import type { Task } from "../control/task.ts";

export const AREAS = ["description", "story", "acceptance", "testCases", "repository", "impact", "readiness"] as const;
export type Area = (typeof AREAS)[number];

export const AREA_TITLES: Record<Area, string> = {
  description: "Description",
  story: "User story",
  acceptance: "Acceptance criteria",
  testCases: "Test cases",
  repository: "Repository",
  impact: "Impact on other areas",
  readiness: "Ready to build",
};

export const MAX_SUMMARY_CHARS = 600;

const hasGherkin = (text: string): boolean => {
  const given = text.search(/\bgiven\b/i);
  const when = text.search(/\bwhen\b/i);
  const then = text.search(/\bthen\b/i);
  return given >= 0 && when > given && then > when;
};

/** What is missing or malformed, per area. An empty list means the area can be scored on quality. */
export function ticketGaps(task: Task, repository: string): Record<Area, string[]> {
  const gaps = Object.fromEntries(AREAS.map((a) => [a, [] as string[]])) as Record<Area, string[]>;

  if (!task.summary?.trim()) gaps.description.push("there is no short description (`summary`)");
  else if (task.summary.length > MAX_SUMMARY_CHARS) gaps.description.push(`the description is longer than ${MAX_SUMMARY_CHARS} characters`);

  if (!task.story) gaps.story.push("there is no user story (`story` with role, want and benefit)");

  const noGherkin = task.acceptance.filter((c) => !c.gherkin || !hasGherkin(c.gherkin)).map((c) => c.id);
  if (noGherkin.length) gaps.acceptance.push(`not written as Given / When / Then: ${noGherkin.join(", ")}`);

  const cases = task.testCases ?? [];
  if (cases.length === 0) gaps.testCases.push("there are no test cases");
  const covered = new Set(cases.flatMap((t) => t.covers));
  const uncovered = task.acceptance.filter((c) => !covered.has(c.id)).map((c) => c.id);
  if (cases.length && uncovered.length) gaps.testCases.push(`no test case covers: ${uncovered.join(", ")}`);

  if (!task.repository) gaps.repository.push("the task does not name its repository");
  else if (task.repository.toLowerCase() !== repository.toLowerCase()) {
    gaps.repository.push(`the task is for ${task.repository}, but this is ${repository}`);
  }

  if (!task.impactedAreas) gaps.impact.push("impacted areas are not stated; list them, or give an empty list if there are none");

  return gaps;
}

export interface AreaResult {
  score: number;
  reason: string;
}

export interface Evaluation {
  areas: Record<Area, AreaResult>;
  mean: number;
  lowest: number;
  passed: boolean;
  minMean: number;
  minArea: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Combine the plain checks with the model's scores. `modelOutput` is untrusted:
 * anything missing, malformed or out of range scores the minimum.
 */
export function evaluateTicket(
  task: Task,
  repository: string,
  modelOutput: unknown,
  thresholds: { minMean: number; minArea: number },
): Evaluation {
  const gaps = ticketGaps(task, repository);
  const scores = isObject(modelOutput) && isObject(modelOutput.scores) ? modelOutput.scores : {};
  const areas = {} as Record<Area, AreaResult>;
  for (const area of AREAS) {
    if (gaps[area].length) {
      areas[area] = { score: 1, reason: gaps[area].join("; ") };
      continue;
    }
    const m = scores[area];
    const score = isObject(m) && typeof m.score === "number" && Number.isFinite(m.score) ? m.score : Number.NaN;
    if (!(score >= 1 && score <= 5)) {
      areas[area] = { score: 1, reason: "the evaluator returned no usable score for this area" };
      continue;
    }
    areas[area] = {
      score,
      reason: isObject(m) && typeof m.reason === "string" ? m.reason.replace(/\s+/g, " ").trim().slice(0, 400) : "",
    };
  }
  const values = AREAS.map((a) => areas[a].score);
  const mean = Math.round((values.reduce((n, v) => n + v, 0) / values.length) * 100) / 100;
  const lowest = Math.min(...values);
  return { areas, mean, lowest, passed: mean >= thresholds.minMean && lowest >= thresholds.minArea, ...thresholds };
}

/** Whether the model needs to be asked at all: with a plain gap, the ticket has already failed. */
export function failsWithoutModel(task: Task, repository: string): boolean {
  return Object.values(ticketGaps(task, repository)).some((g) => g.length > 0);
}

export function evaluationPrompt(template: string, task: Task, nonce: string): string {
  const text = JSON.stringify(task, null, 2);
  if (text.includes(nonce)) throw new Error("ticket contains the delimiter nonce");
  return template.replace(/\{\{NONCE\}\}/g, nonce).replace("{{TICKET}}", () => text);
}

export const EVALUATION_SCHEMA = {
  type: "object",
  required: ["scores"],
  additionalProperties: false,
  properties: {
    scores: {
      type: "object",
      required: [...AREAS],
      additionalProperties: false,
      properties: Object.fromEntries(
        AREAS.map((a) => [
          a,
          {
            type: "object",
            required: ["score", "reason"],
            additionalProperties: false,
            properties: { score: { type: "number", minimum: 1, maximum: 5 }, reason: { type: "string" } },
          },
        ]),
      ),
    },
  },
} as const;

/** The evaluation as a comment for the ticket. Reasons are shown as plain text in a table. */
export function evaluationComment(e: Evaluation, context: { passed: string; failed: string }): string {
  const cell = (s: string) => s.replace(/\|/g, "/").replace(/[`<>\[\]]/g, "").replace(/@/g, "@​");
  const rows = AREAS.map((a) => `| ${AREA_TITLES[a]} | ${e.areas[a].score} | ${cell(e.areas[a].reason)} |`);
  return [
    e.passed ? context.passed : context.failed,
    "",
    "| Area | Score (1 to 5) | Why |",
    "|---|---|---|",
    ...rows,
    "",
    `Average ${e.mean}, lowest ${e.lowest}. To pass, the average must be at least ${e.minMean} and no area below ${e.minArea}.`,
  ].join("\n");
}
