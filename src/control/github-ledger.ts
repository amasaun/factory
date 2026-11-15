/**
 * Event log stored as issue comments (docs/spec.md §3). One task is one issue;
 * each event is one comment authored by the factory App. Comments by anyone
 * else are never read as events, whatever they contain.
 *
 * GitHub has no compare-and-swap on comments, so `append` writes and then
 * re-reads: when two writers race for the same sequence number, the comment
 * with the lower id wins and the loser removes its own comment. A workflow
 * concurrency group per task should make that race rare; this makes it safe.
 */
import { type Ledger, LedgerConflictError } from "./ledger.ts";
import type { FactoryEvent } from "./run.ts";

export const EVENT_MARKER = "<!-- factory-event:v1 -->";

export interface IssueComment {
  id: number;
  /** Login of the comment author as reported by the platform. */
  author: string;
  body: string;
}

/** The small part of the GitHub API the ledger needs. Ordered oldest first. */
export interface IssueComments {
  list(issue: number): Promise<IssueComment[]>;
  create(issue: number, body: string): Promise<IssueComment>;
  delete(commentId: number): Promise<void>;
}

export class LedgerCorruptError extends Error {
  override name = "LedgerCorruptError";
}

export function encodeEvent(seq: number, event: FactoryEvent): string {
  const json = JSON.stringify({ seq, event }, null, 2);
  // Text is kept inside the code fence so nothing in it renders or notifies anyone.
  return `${EVENT_MARKER}\nfactory event ${seq}: \`${event.type}\`\n\n\`\`\`json\n${json}\n\`\`\`\n`;
}

export function decodeEvent(body: string): { seq: number; event: FactoryEvent } {
  const start = body.indexOf("```json\n");
  const end = body.lastIndexOf("\n```");
  if (!body.startsWith(EVENT_MARKER) || start < 0 || end <= start) {
    throw new LedgerCorruptError("event comment has no JSON block");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start + 8, end));
  } catch {
    throw new LedgerCorruptError("event comment JSON does not parse");
  }
  const p = parsed as { seq?: unknown; event?: { type?: unknown; cause?: unknown } };
  if (!Number.isInteger(p?.seq) || typeof p.event?.type !== "string" || typeof p.event?.cause !== "string") {
    throw new LedgerCorruptError("event comment is missing seq, type or cause");
  }
  return { seq: p.seq as number, event: p.event as FactoryEvent };
}

export class GitHubLedger implements Ledger {
  #comments: IssueComments;
  #appLogin: string;

  constructor(comments: IssueComments, appLogin: string) {
    this.#comments = comments;
    this.#appLogin = appLogin;
  }

  /** Winning comment per sequence number, in order. */
  async #winners(taskId: string): Promise<{ id: number; event: FactoryEvent }[]> {
    const issue = Number(taskId);
    if (!Number.isInteger(issue) || issue <= 0) throw new TypeError(`task id '${taskId}' is not an issue number`);
    const bySeq = new Map<number, { id: number; event: FactoryEvent }>();
    for (const c of await this.#comments.list(issue)) {
      if (c.author !== this.#appLogin || !c.body.startsWith(EVENT_MARKER)) continue;
      const { seq, event } = decodeEvent(c.body);
      const existing = bySeq.get(seq);
      if (!existing || c.id < existing.id) bySeq.set(seq, { id: c.id, event });
    }
    const ordered: { id: number; event: FactoryEvent }[] = [];
    for (let seq = 1; seq <= bySeq.size; seq++) {
      const entry = bySeq.get(seq);
      if (!entry) throw new LedgerCorruptError(`task ${taskId} is missing event ${seq}`);
      ordered.push(entry);
    }
    return ordered;
  }

  async read(taskId: string): Promise<FactoryEvent[]> {
    return (await this.#winners(taskId)).map((w) => w.event);
  }

  async append(taskId: string, expectedSeq: number, event: FactoryEvent): Promise<void> {
    const before = await this.#winners(taskId);
    if (before.length !== expectedSeq) {
      throw new LedgerConflictError(`task ${taskId} is at seq ${before.length}, expected ${expectedSeq}`);
    }
    const seq = expectedSeq + 1;
    const mine = await this.#comments.create(Number(taskId), encodeEvent(seq, event));
    const after = await this.#winners(taskId);
    if (after[seq - 1]?.id !== mine.id) {
      await this.#comments.delete(mine.id);
      throw new LedgerConflictError(`task ${taskId}: another writer recorded event ${seq} first`);
    }
  }
}
