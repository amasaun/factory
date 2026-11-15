/** One call to the judge model. Shared by the pipeline and the evals so both measure the same thing. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../control/task.ts";
import { judgePrompt } from "./render.ts";

export interface JudgeAnswer {
  /** The model CLI's whole result object, or null when its output could not be parsed. */
  result: Record<string, unknown> | null;
  /** The structured verdict, untrusted. */
  output: unknown;
  raw: string;
  status: number | null;
}

/** The judge's prompt for a task and a diff. */
export function buildJudgePrompt(root: string, task: Task, diff: string): string {
  return judgePrompt(readFileSync(join(root, "prompts/judge.md"), "utf8"), task, diff, randomUUID());
}

export interface AskJudgeOptions {
  root: string;
  /** A checkout of the base commit. The judge may read it and nothing else. */
  repoDir: string;
  prompt: string;
  command?: string;
  model: string;
  usd: number;
  env: NodeJS.ProcessEnv;
}

export function askJudge(o: AskJudgeOptions): JudgeAnswer {
  const r = spawnSync(
    o.command || "claude",
    [
      "-p", "--safe-mode", "--permission-prompts", "none",
      "--tools", "Read,Glob,Grep", "--allowedTools", "Read", "Glob", "Grep",
      "--model", o.model, "--max-turns", "30", "--no-session-persistence",
      "--max-budget-usd", String(o.usd),
      "--output-format", "json",
      "--json-schema", readFileSync(join(o.root, "schemas/verdict.schema.json"), "utf8"),
    ],
    { cwd: o.repoDir, env: o.env, input: o.prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "inherit"] },
  );
  if (r.error) throw r.error;
  const raw = r.stdout ?? "";
  try {
    const result = JSON.parse(raw) as Record<string, unknown>;
    return { result, output: result.structured_output, raw, status: r.status };
  } catch {
    return { result: null, output: null, raw, status: r.status };
  }
}
