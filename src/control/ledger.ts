/**
 * The event log behind an interface (docs/spec.md §3), so GitHub issue
 * comments, SQLite or anything else can back it without touching transitions.
 */
import type { Limits } from "./budget.ts";
import { type FactoryEvent, type RunState, applyEvent, newRun, replay } from "./run.ts";

export class LedgerConflictError extends Error {
  override name = "LedgerConflictError";
}

export interface Ledger {
  /** Events for a task in append order. */
  read(taskId: string): Promise<FactoryEvent[]>;
  /**
   * Append one event if the log still has `expectedSeq` events. A concurrent
   * writer makes this fail, so two control jobs cannot both advance a run.
   */
  append(taskId: string, expectedSeq: number, event: FactoryEvent): Promise<void>;
}

export class MemoryLedger implements Ledger {
  #logs = new Map<string, FactoryEvent[]>();

  async read(taskId: string): Promise<FactoryEvent[]> {
    return [...(this.#logs.get(taskId) ?? [])];
  }

  async append(taskId: string, expectedSeq: number, event: FactoryEvent): Promise<void> {
    const log = this.#logs.get(taskId) ?? [];
    if (log.length !== expectedSeq) {
      throw new LedgerConflictError(`task ${taskId} is at seq ${log.length}, expected ${expectedSeq}`);
    }
    this.#logs.set(taskId, [...log, structuredClone(event)]);
  }
}

export async function loadRun(ledger: Ledger, taskId: string, limits?: Limits): Promise<RunState> {
  return replay(taskId, await ledger.read(taskId), limits);
}

/**
 * Validate an event against current state, then append it. Nothing is written
 * when the event is not allowed.
 */
export async function advance(
  ledger: Ledger,
  taskId: string,
  event: FactoryEvent,
  limits?: Limits,
): Promise<RunState> {
  const events = await ledger.read(taskId);
  const current = events.reduce(applyEvent, newRun(taskId, limits));
  const next = applyEvent(current, event);
  await ledger.append(taskId, current.seq, event);
  return next;
}
