/** Repository policy file, `.factory/config.json` (docs/spec.md §6). Only the fields the pipeline uses so far. */

export interface RepoConfig {
  version: 1;
  baseBranch: string;
  /** Logins allowed to approve and start a run. */
  approvers: string[];
  commands: { setup: string[][]; test: string[][] };
  extraProtected: string[];
  /**
   * How many times a failed attempt may be sent back to the builder. Each
   * round costs another builder run and usually another judge run. 0 to 2.
   */
  repairRounds: number;
  /**
   * Context size, in tokens, at which the builder is stopped and a fresh one
   * continues. Half the model's context window applies as well if it is lower.
   */
  handoffTokens: number;
  /**
   * Spending caps per model session, in US dollars at list prices, passed to
   * the model CLI. A session that passes its cap is stopped and the run ends.
   */
  builderUsd: number;
  judgeUsd: number;
  /** Runs that may start in this repository per UTC day. Guards against runaway triggers. */
  runsPerDay: number;
  /** Label that starts a run when added to a task issue. */
  triggerLabel: string;
  /** The ticket evaluation that every task must pass before it is started. */
  evaluation: { model: string; minScore: number; minAreaScore: number; usd: number };
}

export const DEFAULT_REPAIR_ROUNDS = 1;
export const MAX_REPAIR_ROUNDS = 2;
export const DEFAULT_HANDOFF_TOKENS = 150_000;
export const MIN_HANDOFF_TOKENS = 20_000;
/** A builder that needs more handoffs than this is working on a task that should be split. */
export const MAX_HANDOFFS = 2;
export const DEFAULT_BUILDER_USD = 1;
export const DEFAULT_JUDGE_USD = 0.5;
export const MAX_SESSION_USD = 50;
export const DEFAULT_RUNS_PER_DAY = 10;
export const DEFAULT_TRIGGER_LABEL = "factory";
export const DEFAULT_EVALUATION = { model: "sonnet", minScore: 4.5, minAreaScore: 4, usd: 0.25 } as const;

const isArgv = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);
const isList = <T>(v: unknown, item: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(item);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function parseConfig(text: string): RepoConfig {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`.factory/config.json does not parse: ${(e as Error).message}`);
  }
  const problems: string[] = [];
  if (raw?.version !== 1) problems.push("version must be 1");
  if (!isText(raw?.baseBranch)) problems.push("baseBranch must be text");
  if (!isList(raw?.approvers, isText) || raw.approvers.length === 0) problems.push("approvers must list at least one login");
  const commands = raw?.commands as Record<string, unknown> | undefined;
  if (!commands || !isList(commands.setup ?? [], isArgv)) problems.push("commands.setup must be a list of argument arrays");
  if (!commands || !isList(commands.test, isArgv) || commands.test.length === 0) {
    problems.push("commands.test must list at least one argument array");
  }
  if (!isList(raw?.extraProtected ?? [], isText)) problems.push("extraProtected must be a list of globs");
  const budget = (raw?.budget ?? {}) as Record<string, unknown>;
  const repairRounds = budget.repairRounds ?? DEFAULT_REPAIR_ROUNDS;
  if (!Number.isInteger(repairRounds) || (repairRounds as number) < 0 || (repairRounds as number) > MAX_REPAIR_ROUNDS) {
    problems.push(`budget.repairRounds must be an integer from 0 to ${MAX_REPAIR_ROUNDS}`);
  }
  const handoffTokens = budget.handoffTokens ?? DEFAULT_HANDOFF_TOKENS;
  if (!Number.isInteger(handoffTokens) || (handoffTokens as number) < MIN_HANDOFF_TOKENS) {
    problems.push(`budget.handoffTokens must be an integer of at least ${MIN_HANDOFF_TOKENS}`);
  }
  const usd = (key: string, fallback: number): number => {
    const v = budget[key] ?? fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_SESSION_USD) {
      problems.push(`budget.${key} must be a number above 0 and at most ${MAX_SESSION_USD}`);
      return fallback;
    }
    return v;
  };
  const builderUsd = usd("builderUsd", DEFAULT_BUILDER_USD);
  const judgeUsd = usd("judgeUsd", DEFAULT_JUDGE_USD);
  const runsPerDay = budget.runsPerDay ?? DEFAULT_RUNS_PER_DAY;
  if (!Number.isInteger(runsPerDay) || (runsPerDay as number) < 1) problems.push("budget.runsPerDay must be a positive integer");
  const triggerLabel = raw?.triggerLabel ?? DEFAULT_TRIGGER_LABEL;
  if (typeof triggerLabel !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 :._-]{0,48}$/.test(triggerLabel)) problems.push("triggerLabel must be a plain label name");
  const ev = (raw?.evaluation ?? {}) as Record<string, unknown>;
  const score = (key: "minScore" | "minAreaScore"): number => {
    const v = ev[key] ?? DEFAULT_EVALUATION[key];
    if (typeof v !== "number" || !(v >= 1 && v <= 5)) {
      problems.push(`evaluation.${key} must be a number from 1 to 5`);
      return DEFAULT_EVALUATION[key];
    }
    return v;
  };
  const evaluation = {
    model: ev.model ?? DEFAULT_EVALUATION.model,
    minScore: score("minScore"),
    minAreaScore: score("minAreaScore"),
    usd: ev.usd ?? DEFAULT_EVALUATION.usd,
  };
  if (typeof evaluation.model !== "string" || !/^[A-Za-z0-9._-]+$/.test(evaluation.model)) problems.push("evaluation.model must be a model name or alias");
  if (typeof evaluation.usd !== "number" || !(evaluation.usd > 0 && evaluation.usd <= MAX_SESSION_USD)) problems.push("evaluation.usd must be a number above 0");
  if (problems.length) throw new Error(`.factory/config.json is invalid: ${problems.join("; ")}`);
  return {
    version: 1,
    baseBranch: raw.baseBranch as string,
    approvers: raw.approvers as string[],
    commands: { setup: (commands!.setup ?? []) as string[][], test: commands!.test as string[][] },
    extraProtected: (raw.extraProtected ?? []) as string[],
    repairRounds: repairRounds as number,
    handoffTokens: handoffTokens as number,
    builderUsd,
    judgeUsd,
    runsPerDay: runsPerDay as number,
    triggerLabel: triggerLabel as string,
    evaluation: evaluation as RepoConfig["evaluation"],
  };
}
