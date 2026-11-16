/** One call to the model that scores a ticket. Shared by the pipeline and the evals so both measure the same thing. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../control/task.ts";
import { EVALUATION_SCHEMA, evaluationPrompt } from "./evaluate.ts";

export interface EvaluatorAnswer {
  /** The model CLI's whole result object, or null when its output could not be parsed. */
  result: Record<string, unknown> | null;
  /** The structured scores, untrusted. */
  output: unknown;
  /** Raw text the CLI printed. */
  raw: string;
}

export interface AskOptions {
  /** The factory's root folder, where the prompt lives. */
  root: string;
  command?: string;
  model: string;
  usd: number;
  env: NodeJS.ProcessEnv;
}

export function askEvaluator(task: Task, o: AskOptions): EvaluatorAnswer {
  const template = readFileSync(join(o.root, "prompts/evaluate.md"), "utf8");
  const r = spawnSync(
    o.command || "claude",
    [
      "-p", "--safe-mode", "--permission-prompts", "none", "--tools", "",
      "--model", o.model, "--max-turns", "3", "--no-session-persistence",
      "--max-budget-usd", String(o.usd),
      "--output-format", "json", "--json-schema", JSON.stringify(EVALUATION_SCHEMA),
    ],
    {
      // An empty folder: the evaluator reads the ticket and nothing else.
      cwd: mkdtempSync(join(tmpdir(), "factory-evaluate-")),
      env: o.env,
      input: evaluationPrompt(template, task, randomUUID()),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"],
    },
  );
  if (r.error) throw r.error;
  const raw = r.stdout ?? "";
  if (r.status !== 0) throw Object.assign(new Error(`the ticket evaluator exited with ${r.status ?? r.signal}`), { raw });
  try {
    const result = JSON.parse(raw) as Record<string, unknown>;
    return { result, output: result.structured_output, raw };
  } catch {
    return { result: null, output: null, raw };
  }
}
