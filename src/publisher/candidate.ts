/**
 * Candidate intake (docs/spec.md §4, §5, §9 "Freeze"). A worker never pushes;
 * it hands over a Git bundle. The publisher imports the bundle as objects
 * only, checks its shape and every path it touches, and only then treats the
 * head commit as a frozen candidate.
 */
import { type Violation, candidateViolations } from "../control/guards.ts";
import { git, gitOk } from "./git.ts";

export class IntakeError extends Error {
  override name = "IntakeError";
}

export interface IntakeRequest {
  /** A clean clone owned by the publisher that already contains `baseCommit`. */
  repoDir: string;
  bundlePath: string;
  /** The base commit recorded at admission. */
  baseCommit: string;
  taskId: string;
  attempt: number;
  scope: { permitted: readonly string[]; forbidden: readonly string[] };
  extraProtected?: readonly string[];
  maintenancePaths?: readonly string[];
  /** Upper bound on commits in one candidate. */
  maxCommits?: number;
}

export interface FrozenCandidate {
  commit: string;
  tree: string;
  /** New commits, oldest first. */
  commits: string[];
  /** Every path touched by any new commit, including paths later reverted. */
  changedPaths: string[];
  violations: Violation[];
  /** Local ref holding the imported candidate. */
  ref: string;
}

const SHA = /^[0-9a-f]{40}$/;

interface RawChange {
  path: string;
  newMode: string;
}

/** Parse `git diff-tree -r --raw -z` output for one commit. */
function parseRaw(out: string): RawChange[] {
  const parts = out.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const path = parts[i + 1]!;
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]/.exec(meta);
    if (!m) throw new IntakeError(`unreadable change record: ${JSON.stringify(meta)}`);
    changes.push({ path, newMode: m[2]! });
  }
  return changes;
}

export function intakeCandidate(req: IntakeRequest): FrozenCandidate {
  const { repoDir, bundlePath, baseCommit } = req;
  if (!SHA.test(baseCommit)) throw new IntakeError("base commit must be a full commit id");
  if (!/^[0-9]+$/.test(req.taskId) || !Number.isInteger(req.attempt) || req.attempt < 1) {
    throw new IntakeError("task id and attempt must be positive integers");
  }
  if (!gitOk(repoDir, ["cat-file", "-e", `${baseCommit}^{commit}`])) {
    throw new IntakeError("the publisher clone does not contain the base commit");
  }

  let heads: string[];
  try {
    heads = git(repoDir, ["bundle", "list-heads", bundlePath]).trim().split("\n").filter(Boolean);
  } catch {
    throw new IntakeError("not a readable Git bundle");
  }
  if (heads.length !== 1) throw new IntakeError(`bundle must carry exactly one head, found ${heads.length}`);
  const [claimed, headRef] = heads[0]!.split(" ");
  if (!claimed || !SHA.test(claimed) || !headRef) throw new IntakeError("bundle head is malformed");

  const ref = `refs/factory/incoming/${req.taskId}/${req.attempt}`;
  try {
    git(repoDir, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--force", bundlePath, `${headRef}:${ref}`]);
  } catch (e) {
    throw new IntakeError(`bundle could not be imported: ${String((e as { stderr?: string }).stderr ?? e).trim().split("\n")[0]}`);
  }

  const reject = (message: string): never => {
    gitOk(repoDir, ["update-ref", "-d", ref]);
    throw new IntakeError(message);
  };

  const commit = git(repoDir, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (commit !== claimed) reject("imported head does not match the bundle's claimed head");
  if (commit === baseCommit) reject("candidate contains no changes");
  if (!gitOk(repoDir, ["merge-base", "--is-ancestor", baseCommit, commit])) {
    reject("candidate does not descend from the recorded base commit");
  }

  const log = git(repoDir, ["rev-list", "--reverse", "--parents", `${baseCommit}..${commit}`]).trim().split("\n");
  const max = req.maxCommits ?? 50;
  if (log.length > max) reject(`candidate has ${log.length} commits; the limit is ${max}`);
  const commits: string[] = [];
  for (const line of log) {
    const [id, ...parents] = line.split(" ");
    if (parents.length !== 1) reject(`commit ${id} is not a single-parent commit`);
    commits.push(id!);
  }
  // With one parent each and the base as an ancestor, the history is a straight line from the base.
  if (git(repoDir, ["rev-parse", `${commits[0]}^`]).trim() !== baseCommit) {
    reject("candidate history does not start at the base commit");
  }

  const changed = new Set<string>();
  const violations: Violation[] = [];
  for (const id of commits) {
    const raw = git(repoDir, ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-commit-id", id]);
    for (const change of parseRaw(raw)) {
      changed.add(change.path);
      if (change.newMode === "160000") {
        violations.push({ path: change.path, kind: "invalid-path", rule: "submodule entry" });
      } else if (change.newMode === "120000") {
        violations.push({ path: change.path, kind: "invalid-path", rule: "symbolic link" });
      }
    }
  }
  const changedPaths = [...changed].sort();
  violations.push(
    ...candidateViolations({
      changedPaths,
      scope: req.scope,
      extraProtected: req.extraProtected,
      maintenancePaths: req.maintenancePaths,
    }),
  );

  const tree = git(repoDir, ["rev-parse", `${commit}^{tree}`]).trim();
  return { commit, tree, commits, changedPaths, violations, ref };
}
