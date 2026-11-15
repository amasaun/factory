import { execFileSync } from "node:child_process";

/**
 * Run git for the trusted side. User and system configuration are ignored,
 * hooks and helper programs are disabled, and nothing can prompt. Worker
 * output is only ever handled as Git objects; it is never checked out here.
 */
export function git(cwd: string, args: readonly string[], opts: { input?: string } = {}): string {
  return execFileSync(
    "git",
    [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "protocol.ext.allow=never",
      "-c", "fetch.fsckObjects=true",
      "-c", "transfer.fsckObjects=true",
      ...args,
    ],
    {
      cwd,
      input: opts.input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: "/nonexistent",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        LC_ALL: "C",
      },
    },
  );
}

/** True when the command exits zero. Any other outcome is false. */
export function gitOk(cwd: string, args: readonly string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}
