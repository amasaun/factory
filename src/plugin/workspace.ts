/**
 * A workspace is a folder that holds several repository checkouts side by
 * side. The plugin's commands can be run from that folder: this finds the
 * repositories in it and which of them are set up for the factory.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorkspaceRepo {
  /** Folder name inside the workspace, or "." for the workspace folder itself. */
  folder: string;
  path: string;
  /** `owner/name` on GitHub, or null when the checkout has no GitHub remote. */
  repo: string | null;
  /** True when `.factory/config.json` exists in the checkout. */
  setUp: boolean;
}

/** `owner/name` from a GitHub remote URL in any of its usual spellings. */
export function githubRepo(remoteUrl: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function describe(path: string, folder: string): WorkspaceRepo | null {
  if (!existsSync(join(path, ".git"))) return null;
  let repo: string | null = null;
  try {
    const url = execFileSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    repo = githubRepo(url);
  } catch {
    // No origin remote: still a checkout, just not one the factory can use.
  }
  return { folder, path, repo, setUp: existsSync(join(path, ".factory", "config.json")) };
}

const SKIP = new Set(["node_modules", "vendor", "dist", "build"]);

/**
 * Repositories in a folder: its immediate subfolders that are checkouts, and
 * the folder itself when it is one. The folder does not have to be a
 * repository, and it may be one that also holds other checkouts. Hidden
 * folders and dependency folders are not looked into.
 */
export function findRepos(dir: string): WorkspaceRepo[] {
  const root = resolve(dir);
  const self = describe(root, ".");
  const found: WorkspaceRepo[] = self ? [self] : [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".") || SKIP.has(name)) continue;
    const path = join(root, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const repo = describe(path, name);
    if (repo) found.push(repo);
  }
  return found;
}

export function renderWorkspace(repos: WorkspaceRepo[]): string {
  if (repos.length === 0) return "No repository checkouts found here.";
  const rows = repos.map((r) => `| ${r.folder} | ${r.repo ?? "(no GitHub remote)"} | ${r.repo ? (r.setUp ? "yes" : "no") : ""} |`);
  const ready = repos.filter((r) => r.repo && r.setUp).length;
  return ["| Folder | Repository | Set up for the factory |", "|---|---|---|", ...rows, "", `${ready} of ${repos.length} repositor${repos.length === 1 ? "y is" : "ies are"} set up.`].join("\n");
}
