/**
 * Publication (docs/spec.md §9 "Publish", §13, §15). The publisher pushes
 * exactly the frozen candidate to `factory/<task-id>` and keeps one draft pull
 * request for that branch. Both steps are safe to repeat after a crash.
 */
import type { FrozenCandidate } from "./candidate.ts";
import { git } from "./git.ts";

export class PublishError extends Error {
  override name = "PublishError";
}
/** The branch holds a commit the factory did not put there. The run must be handed off. */
export class ForeignCommitError extends Error {
  override name = "ForeignCommitError";
}

export const branchFor = (taskId: string): string => {
  if (!/^[1-9][0-9]*$/.test(taskId)) throw new PublishError("task id must be an issue number");
  return `factory/${taskId}`;
};

export interface PushRequest {
  /** The publisher's clone, holding the imported candidate. */
  repoDir: string;
  /** Remote name or URL of the target repository. */
  remote: string;
  taskId: string;
  candidate: FrozenCandidate;
  /**
   * The commit the factory last put on the branch: the claim (base commit) or
   * the previously published candidate. `null` when the branch must not exist.
   */
  expectedRemote: string | null;
}

export interface PushResult {
  branch: string;
  commit: string;
  /** False when the branch already pointed at the candidate. */
  pushed: boolean;
}

function remoteHead(repoDir: string, remote: string, ref: string): string | null {
  const out = git(repoDir, ["ls-remote", remote, ref]).trim();
  return out ? out.split(/\s+/)[0]! : null;
}

export function pushCandidate(req: PushRequest): PushResult {
  const { repoDir, remote, candidate } = req;
  if (candidate.violations.length > 0) {
    throw new PublishError(`candidate has ${candidate.violations.length} unresolved violation(s)`);
  }
  const branch = branchFor(req.taskId);
  const ref = `refs/heads/${branch}`;

  const current = remoteHead(repoDir, remote, ref);
  if (current === candidate.commit) return { branch, commit: candidate.commit, pushed: false };
  if (current !== req.expectedRemote) {
    throw new ForeignCommitError(
      `${branch} is at ${current ?? "(absent)"}, expected ${req.expectedRemote ?? "(absent)"}`,
    );
  }

  try {
    // The lease makes the check above atomic: the push only lands if the branch still holds what we expect.
    git(repoDir, [
      "push", "--quiet", "--no-verify",
      `--force-with-lease=${ref}:${req.expectedRemote ?? ""}`,
      remote,
      `${candidate.commit}:${ref}`,
    ]);
  } catch (e) {
    const after = remoteHead(repoDir, remote, ref);
    if (after !== candidate.commit && after !== req.expectedRemote) {
      throw new ForeignCommitError(`${branch} changed during publication; now at ${after ?? "(absent)"}`);
    }
    if (after !== candidate.commit) {
      throw new PublishError(`push failed: ${String((e as { stderr?: string }).stderr ?? e).trim().split("\n").pop()}`);
    }
  }
  if (remoteHead(repoDir, remote, ref) !== candidate.commit) {
    throw new PublishError(`${branch} does not point at the candidate after the push`);
  }
  return { branch, commit: candidate.commit, pushed: true };
}

export interface PullRequest {
  number: number;
  head: string;
  base: string;
  draft: boolean;
  body: string;
}

/** The small part of the GitHub API the publisher needs. */
export interface PullRequests {
  listOpenByHead(head: string): Promise<PullRequest[]>;
  create(pr: { head: string; base: string; title: string; body: string; draft: true }): Promise<PullRequest>;
  update(number: number, changes: { title: string; body: string }): Promise<PullRequest>;
}

export const taskMarker = (taskId: string): string => `<!-- factory-task:${taskId} -->`;

/**
 * Create the draft pull request for a task, or update the one that exists. It
 * is found by head branch, so a retry after a timeout never opens a second one.
 */
export async function ensurePullRequest(
  client: PullRequests,
  pr: { taskId: string; base: string; title: string; body: string },
): Promise<{ number: number; created: boolean }> {
  const head = branchFor(pr.taskId);
  if (pr.base === head || pr.base.startsWith("factory/")) throw new PublishError("base cannot be a factory branch");
  const body = `${taskMarker(pr.taskId)}\n${pr.body}`;
  const open = await client.listOpenByHead(head);
  if (open.length > 1) throw new PublishError(`${open.length} open pull requests for ${head}; expected at most one`);
  const existing = open[0];
  if (existing) {
    if (existing.base !== pr.base) throw new PublishError(`pull request #${existing.number} targets ${existing.base}, not ${pr.base}`);
    if (!existing.body.includes(taskMarker(pr.taskId))) {
      throw new PublishError(`pull request #${existing.number} on ${head} was not opened by the factory`);
    }
    await client.update(existing.number, { title: pr.title, body });
    return { number: existing.number, created: false };
  }
  const created = await client.create({ head, base: pr.base, title: pr.title, body, draft: true });
  return { number: created.number, created: true };
}
