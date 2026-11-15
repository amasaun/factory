/**
 * Minimal GitHub REST client for the trusted side. It implements the narrow
 * interfaces the ledger and publisher depend on, and nothing else.
 */
import type { IssueComment, IssueComments } from "../control/github-ledger.ts";
import type { PullRequest, PullRequests } from "../publisher/publish.ts";

export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GitHubOptions {
  token: string;
  /** `owner/name` */
  repo: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

export interface Issue {
  number: number;
  author: string;
  state: string;
  body: string;
  isPullRequest: boolean;
}

const PAGE = 100;
const MAX_PAGES = 50;

export class GitHub implements IssueComments, PullRequests {
  #token: string;
  #repo: string;
  #owner: string;
  #api: string;
  #fetch: typeof fetch;

  constructor(opts: GitHubOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) throw new TypeError("repo must be owner/name");
    if (!opts.token) throw new TypeError("a token is required");
    this.#token = opts.token;
    this.#repo = opts.repo;
    this.#owner = opts.repo.split("/")[0]!;
    this.#api = (opts.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.#fetch = opts.fetch ?? fetch;
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#api}/repos/${this.#repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "factory",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { message?: string }).message ?? "";
      } catch {
        // No JSON body; the status is enough.
      }
      throw new GitHubApiError(res.status, `${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async #paged(path: string): Promise<unknown[]> {
    const all: unknown[] = [];
    const join = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = (await this.#request("GET", `${path}${join}per_page=${PAGE}&page=${page}`)) as unknown[];
      all.push(...batch);
      if (batch.length < PAGE) return all;
    }
    throw new GitHubApiError(0, `${path} has more than ${PAGE * MAX_PAGES} entries`);
  }

  async getIssue(number: number): Promise<Issue> {
    const i = (await this.#request("GET", `/issues/${number}`)) as {
      number: number; state: string; body: string | null; user: { login: string }; pull_request?: unknown;
    };
    return { number: i.number, author: i.user.login, state: i.state, body: i.body ?? "", isPullRequest: !!i.pull_request };
  }

  async addLabels(issue: number, labels: string[]): Promise<void> {
    await this.#request("POST", `/issues/${issue}/labels`, { labels });
  }

  /** Remove a label. A label that is not on the issue is not an error. */
  async removeLabel(issue: number, label: string): Promise<void> {
    try {
      await this.#request("DELETE", `/issues/${issue}/labels/${encodeURIComponent(label)}`);
    } catch (e) {
      if (!(e instanceof GitHubApiError && e.status === 404)) throw e;
    }
  }

  /** How many runs of one workflow file were created on or after a date (YYYY-MM-DD, UTC). */
  async countWorkflowRuns(workflowFile: string, since: string): Promise<number> {
    const r = (await this.#request(
      "GET",
      `/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=1&created=${encodeURIComponent(`>=${since}`)}`,
    )) as { total_count?: number };
    return r.total_count ?? 0;
  }

  // IssueComments

  async list(issue: number): Promise<IssueComment[]> {
    const raw = (await this.#paged(`/issues/${issue}/comments`)) as { id: number; body: string | null; user: { login: string } }[];
    return raw.map((c) => ({ id: c.id, author: c.user.login, body: c.body ?? "" })).sort((a, b) => a.id - b.id);
  }

  async delete(commentId: number): Promise<void> {
    await this.#request("DELETE", `/issues/comments/${commentId}`);
  }

  // PullRequests

  async listOpenByHead(head: string): Promise<PullRequest[]> {
    const raw = (await this.#paged(`/pulls?state=open&head=${encodeURIComponent(`${this.#owner}:${head}`)}`)) as RawPull[];
    // Only branches in this repository count; a fork can carry the same branch name.
    return raw.filter((p) => p.head.ref === head && p.head.repo?.full_name === this.#repo).map(toPull);
  }

  async update(number: number, changes: { title: string; body: string }): Promise<PullRequest> {
    return toPull((await this.#request("PATCH", `/pulls/${number}`, changes)) as RawPull);
  }

  // Both interfaces declare `create`; the argument shape tells them apart.
  create(issue: number, body: string): Promise<IssueComment>;
  create(pr: { head: string; base: string; title: string; body: string; draft: true }): Promise<PullRequest>;
  async create(
    a: number | { head: string; base: string; title: string; body: string; draft: true },
    b?: string,
  ): Promise<IssueComment | PullRequest> {
    if (typeof a === "number") {
      const c = (await this.#request("POST", `/issues/${a}/comments`, { body: b })) as {
        id: number; body: string | null; user: { login: string };
      };
      return { id: c.id, author: c.user.login, body: c.body ?? "" };
    }
    return toPull((await this.#request("POST", "/pulls", a)) as RawPull);
  }
}

interface RawPull {
  number: number;
  draft?: boolean;
  body: string | null;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string };
}

const toPull = (p: RawPull): PullRequest => ({
  number: p.number,
  head: p.head.ref,
  base: p.base.ref,
  draft: !!p.draft,
  body: p.body ?? "",
});
