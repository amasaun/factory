/** One view of factory tasks across repositories, read from each repository's issues and pull requests. */
import { GitHubLedger } from "../control/github-ledger.ts";
import { TASK_MARKER } from "../control/issue-task.ts";
import { replay } from "../control/run.ts";
import type { State } from "../control/states.ts";
import { type Gh, GhError } from "./gh.ts";

export interface TaskStatus {
  repo: string;
  issue: number;
  title: string;
  /** Run state, or `not started` when the task has no events, or `unreadable`. */
  state: State | "not started" | "unreadable";
  /** What the last event said happened. */
  detail: string;
  pullRequest: number | null;
  issueOpen: boolean;
}

export interface RepoStatus {
  repo: string;
  tasks: TaskStatus[];
  error: string | null;
}

/** What each state means for the person reading the list. */
export function attention(t: TaskStatus): "act" | "wait" | "done" {
  // Closing the task issue is how a person says a stopped or failed task needs nothing more.
  if (!t.issueOpen && ["needs-human", "failed", "unreadable", "not started"].includes(t.state)) return "done";
  switch (t.state) {
    case "needs-human":
    case "ready":
    case "ci-pending":
    case "changes-requested":
    case "handed-off":
    case "failed":
    case "unreadable":
      return "act";
    case "not started":
      return "act";
    case "merged":
    case "cancelled":
      return "done";
    default:
      return "wait";
  }
}

export async function repoStatus(gh: Gh, repo: string, opts: { appLogin?: string; limit?: number } = {}): Promise<RepoStatus> {
  const appLogin = opts.appLogin ?? "github-actions[bot]";
  try {
    const issues = gh
      .list<{ number: number; title: string; state: string; body: string; pr: boolean }>(
        `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=${opts.limit ?? 50}`,
        '{number, title, state, body: (.body // ""), pr: (.pull_request != null)}',
      )
      .filter((i) => !i.pr && i.body.includes(TASK_MARKER));
    const pulls = gh.list<{ number: number; head: string; merged: boolean; state: string }>(
      `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${opts.limit ?? 50}`,
      "{number, head: .head.ref, merged: (.merged_at != null), state}",
    );
    const ledger = new GitHubLedger(gh.comments(repo), appLogin);
    const tasks: TaskStatus[] = [];
    for (const issue of issues) {
      const pr = pulls.find((p) => p.head === `factory/${issue.number}`) ?? null;
      const base = { repo, issue: issue.number, title: issue.title, pullRequest: pr?.number ?? null, issueOpen: issue.state === "open" };
      try {
        const events = await ledger.read(String(issue.number));
        if (events.length === 0) {
          tasks.push({ ...base, state: "not started", detail: "task written, run not started" });
          continue;
        }
        const run = replay(String(issue.number), events);
        // The log ends at publication; what happened to the pull request afterwards is read from the pull request.
        const state: State = run.state === "ci-pending" && pr?.merged ? "merged" : run.state === "ci-pending" && pr?.state === "closed" ? "cancelled" : run.state;
        tasks.push({ ...base, state, detail: events.at(-1)!.cause });
      } catch (e) {
        if (e instanceof GhError) throw e;
        tasks.push({ ...base, state: "unreadable", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    return { repo, tasks, error: null };
  } catch (e) {
    return { repo, tasks: [], error: e instanceof Error ? e.message : String(e) };
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function renderStatus(repos: RepoStatus[]): string {
  const lines: string[] = [];
  for (const r of repos) {
    lines.push(`## ${r.repo}`, "");
    if (r.error) {
      lines.push(`Could not read this repository: ${r.error}`, "");
      continue;
    }
    if (r.tasks.length === 0) {
      lines.push("No factory tasks.", "");
      continue;
    }
    lines.push("| Task | Title | State | Pull request | Needs you | Last event |", "|---|---|---|---|---|---|");
    for (const t of r.tasks) {
      const need = attention(t);
      lines.push(
        `| #${t.issue} | ${clip(t.title.replace(/\|/g, "/"), 50)} | ${t.state} | ${t.pullRequest ? `#${t.pullRequest}` : ""} | ${need === "act" ? "yes" : need === "wait" ? "no, in progress" : "no"} | ${clip(t.detail.replace(/\|/g, "/").replace(/\s+/g, " "), 90)} |`,
      );
    }
    lines.push("");
  }
  const all = repos.flatMap((r) => r.tasks);
  lines.push(`${all.filter((t) => attention(t) === "act").length} task(s) need you, ${all.filter((t) => attention(t) === "wait").length} in progress, across ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}.`);
  return lines.join("\n");
}
