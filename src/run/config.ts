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
}

export const DEFAULT_REPAIR_ROUNDS = 1;
export const MAX_REPAIR_ROUNDS = 2;

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
  if (problems.length) throw new Error(`.factory/config.json is invalid: ${problems.join("; ")}`);
  return {
    version: 1,
    baseBranch: raw.baseBranch as string,
    approvers: raw.approvers as string[],
    commands: { setup: (commands!.setup ?? []) as string[][], test: commands!.test as string[][] },
    extraProtected: (raw.extraProtected ?? []) as string[],
    repairRounds: repairRounds as number,
  };
}
