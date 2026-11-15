/**
 * GitHub access for the plugin's commands, through the `gh` command the person
 * is already signed in with. The plugin never handles a token itself.
 */
import { execFileSync } from "node:child_process";
import type { IssueComment, IssueComments } from "../control/github-ledger.ts";

export class GhError extends Error {
  override name = "GhError";
}

export class Gh {
  #command: string;
  constructor(command = process.env.FACTORY_GH || "gh") {
    this.#command = command;
  }

  /** Run `gh api`. With `paginate`, the jq filter must emit one JSON value per line. */
  api(path: string, opts: { jq?: string; paginate?: boolean } = {}): string {
    const args = ["api", path];
    if (opts.paginate) args.push("--paginate");
    if (opts.jq) args.push("--jq", opts.jq);
    try {
      return execFileSync(this.#command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { code?: string; stderr?: string; message?: string };
      if (err.code === "ENOENT") throw new GhError("the GitHub CLI (gh) is not installed or not on PATH");
      throw new GhError(`gh api ${path} failed: ${(err.stderr || err.message || "").trim().split("\n")[0]}`);
    }
  }

  /** Every item of a paginated list, reduced by a jq object expression. */
  list<T>(path: string, fields: string): T[] {
    const out = this.api(path, { paginate: true, jq: `.[] | ${fields}` });
    return out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
  }

  /** Read-only view of an issue's comments, in the shape the event ledger reads. */
  comments(repo: string): IssueComments {
    const fail = (): never => {
      throw new GhError("the plugin reads run history; it never writes it");
    };
    return {
      list: async (issue: number): Promise<IssueComment[]> =>
        this.list<IssueComment>(`repos/${repo}/issues/${issue}/comments?per_page=100`, "{id, author: .user.login, body: (.body // \"\")}").sort((a, b) => a.id - b.id),
      create: fail,
      delete: fail,
    };
  }
}

export const isRepoName = (s: string): boolean => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
