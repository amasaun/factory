/**
 * Path checks the publisher applies to a candidate before any push
 * (docs/spec.md §4, §5). These are enforced by trusted code and cannot be
 * relaxed by a task; only an approved maintenance task may touch protected
 * paths, and only the ones it lists.
 */

/** Protected regardless of repository configuration. */
export const DEFAULT_PROTECTED: readonly string[] = [
  // CI and workflow definitions, CODEOWNERS
  ".github/**",
  "CODEOWNERS",
  "docs/CODEOWNERS",
  ".gitlab-ci.yml",
  ".circleci/**",
  ".buildkite/**",
  "Jenkinsfile",
  // Factory policy
  ".factory/**",
  // Claude Code project settings, hooks, MCP configuration and plugins
  ".claude/**",
  ".claude-plugin/**",
  ".mcp.json",
  // Git behaviour: hooks, filters, submodules
  ".githooks/**",
  ".husky/**",
  ".gitattributes",
  ".gitmodules",
  // Scanner configuration
  ".gitleaks.toml",
  ".gitleaksignore",
  ".trivyignore",
  ".semgrepignore",
];

function globToRegExp(glob: string, flags = ""): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, flags);
}

/** Minimal glob: `**` spans directories, `*` and `?` stay within one segment. */
export function matchesGlob(path: string, glob: string, opts: { ignoreCase?: boolean } = {}): boolean {
  return globToRegExp(glob, opts.ignoreCase ? "i" : "").test(path);
}

export type ViolationKind = "invalid-path" | "protected" | "forbidden" | "out-of-scope";

export interface Violation {
  path: string;
  kind: ViolationKind;
  rule: string;
}

export interface CandidateCheck {
  /**
   * Every path the candidate adds, modifies or deletes relative to its base.
   * For a rename, include both the old and the new path.
   */
  changedPaths: readonly string[];
  scope: { permitted: readonly string[]; forbidden: readonly string[] };
  /** Additional protected globs from repository policy. They can only add protection. */
  extraProtected?: readonly string[];
  /** Protected globs an approved maintenance task may change. Empty for ordinary tasks. */
  maintenancePaths?: readonly string[];
}

function invalidReason(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes("\\")) return "backslash in path";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control character in path";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "non-normalized path";
  if (segments.some((s) => s.toLowerCase() === ".git")) return "path inside Git metadata";
  return null;
}

/** Returns every violation; an empty list means the candidate may proceed. */
export function candidateViolations(check: CandidateCheck): Violation[] {
  const protectedGlobs = [...DEFAULT_PROTECTED, ...(check.extraProtected ?? [])];
  const maintenance = check.maintenancePaths ?? [];
  const violations: Violation[] = [];

  for (const path of check.changedPaths) {
    const invalid = invalidReason(path);
    if (invalid) {
      violations.push({ path, kind: "invalid-path", rule: invalid });
      continue;
    }
    // Protected paths match case-insensitively: over-blocking is the safe direction.
    const protectedBy = protectedGlobs.find((g) => matchesGlob(path, g, { ignoreCase: true }));
    if (protectedBy) {
      if (!maintenance.some((g) => matchesGlob(path, g))) {
        violations.push({ path, kind: "protected", rule: protectedBy });
      }
      continue;
    }
    const forbiddenBy = check.scope.forbidden.find((g) => matchesGlob(path, g));
    if (forbiddenBy) {
      violations.push({ path, kind: "forbidden", rule: forbiddenBy });
      continue;
    }
    if (!check.scope.permitted.some((g) => matchesGlob(path, g))) {
      violations.push({ path, kind: "out-of-scope", rule: "not matched by scope.permitted" });
    }
  }
  return violations;
}
