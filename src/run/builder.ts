/**
 * Runs the builder and watches how much context it has used. When the context
 * passes the handoff limit, the builder is stopped and a fresh one continues
 * from the working tree. Long sessions cost more per turn and drift, so this
 * is a backstop for tasks that turn out larger than expected; the first line
 * of defence is keeping tasks small.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Share of the model's context window at which a handoff is forced, whatever the token limit says. */
export const WINDOW_SHARE = 0.5;

interface Usage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

/** Tokens in context after an assistant message with this usage. */
export function contextTokens(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
}

/** Follows one builder session's streamed events. */
export class ContextMonitor {
  #tokenLimit: number;
  window: number | null = null;
  peak = 0;
  turns = 0;
  result: Record<string, unknown> | null = null;

  constructor(tokenLimit: number) {
    this.#tokenLimit = tokenLimit;
  }

  /** The limit in force: the configured token count, or half the model's window if that is smaller. */
  get limit(): number {
    return this.window === null ? this.#tokenLimit : Math.min(this.#tokenLimit, Math.floor(this.window * WINDOW_SHARE));
  }

  /** Feed one parsed event. Returns true when the session should be handed off. */
  observe(event: unknown): boolean {
    if (typeof event !== "object" || event === null) return false;
    const e = event as { type?: string; value?: { effective_window?: unknown }; message?: { usage?: Usage }; parent_tool_use_id?: unknown };
    if (e.type === "autocompact_state" && typeof e.value?.effective_window === "number") {
      this.window = e.value.effective_window;
    } else if (e.type === "result") {
      this.result = event as Record<string, unknown>;
    } else if (e.type === "assistant" && e.message?.usage && !e.parent_tool_use_id) {
      this.turns++;
      this.peak = Math.max(this.peak, contextTokens(e.message.usage));
      return this.peak >= this.limit;
    }
    return false;
  }
}

export interface SegmentReport {
  /** Highest context size seen, in tokens. */
  peak: number;
  turns: number;
  handedOff: boolean;
  exitCode: number | null;
}

export interface BuilderReport {
  segments: SegmentReport[];
  handoffs: number;
  limit: number;
  /** The final result event from the last segment, when it finished on its own. */
  result: Record<string, unknown> | null;
  /** Why the run did not complete, when it did not. */
  failure: string | null;
}

export interface BuilderOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Prompt for segment 1, and a function giving the prompt for each later segment. */
  prompt: string;
  handoffPrompt: (handoff: number) => string;
  tokenLimit: number;
  maxHandoffs: number;
  log?: (line: string) => void;
}

function runSegment(o: BuilderOptions, prompt: string): Promise<{ monitor: ContextMonitor; handedOff: boolean; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const monitor = new ContextMonitor(o.tokenLimit);
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "inherit"] });
    let handedOff = false;
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (handedOff || !line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (monitor.observe(event)) {
        // Stop before this message's tool calls run; the next builder picks up from the working tree.
        handedOff = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }
    });
    child.on("close", (code) => resolve({ monitor, handedOff, exitCode: code }));
  });
}

export async function runBuilder(o: BuilderOptions): Promise<BuilderReport> {
  const log = o.log ?? (() => {});
  const report: BuilderReport = { segments: [], handoffs: 0, limit: o.tokenLimit, result: null, failure: null };
  for (let segment = 1; ; segment++) {
    const prompt = segment === 1 ? o.prompt : o.handoffPrompt(segment - 1);
    const { monitor, handedOff, exitCode } = await runSegment(o, prompt);
    report.limit = monitor.limit;
    report.segments.push({ peak: monitor.peak, turns: monitor.turns, handedOff, exitCode });
    log(`builder segment ${segment}: ${monitor.turns} turn(s), peak context ${monitor.peak} tokens, limit ${monitor.limit}${handedOff ? ", handed off" : ""}`);
    if (!handedOff) {
      report.result = monitor.result;
      if (exitCode !== 0) report.failure = `the builder exited with ${exitCode}`;
      else if (!monitor.result) report.failure = "the builder ended without a result";
      else if (monitor.result.is_error === true) report.failure = "the builder reported an error";
      return report;
    }
    report.handoffs++;
    if (report.handoffs > o.maxHandoffs) {
      report.failure = `the builder passed the context limit ${report.handoffs} times; the task is too large for one run and should be split`;
      return report;
    }
  }
}
