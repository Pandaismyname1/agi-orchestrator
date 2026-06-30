/**
 * Bulk-action helpers — pure logic for which selected sessions can take a given
 * action, so the toolbar can show accurate counts and skip no-ops. No Svelte deps
 * (unit-testable).
 *
 * - start: a session that isn't already active or queued (idle/stopped/done/
 *   error/blocked) — starting it kicks off a run (or queues it).
 * - stop: a session that's active or pending (running/manual/needs-input/paused/
 *   queued/blocked) — stopping halts it or removes it from the queue.
 */

/** Minimal shape the bulk helpers read. SessionView satisfies it. */
export interface SelectableSession {
  id: string;
  status?: string;
}

export type BulkAction = "start" | "stop";

const STARTABLE = new Set(["idle", "stopped", "done", "error", "blocked"]);
const STOPPABLE = new Set(["running", "manual", "needs-input", "paused", "queued", "blocked"]);

export function canStart(status: string | undefined): boolean {
  return !!status && STARTABLE.has(status);
}
export function canStop(status: string | undefined): boolean {
  return !!status && STOPPABLE.has(status);
}
export function canDo(action: BulkAction, status: string | undefined): boolean {
  return action === "start" ? canStart(status) : canStop(status);
}

/**
 * Of the `selected` ids, those present in `sessions` whose status permits `action`.
 * Order follows `sessions` (stable, deduped by the selection set).
 */
export function actionableIds<T extends SelectableSession>(
  sessions: T[],
  selected: ReadonlySet<string>,
  action: BulkAction,
): string[] {
  return sessions.filter((s) => selected.has(s.id) && canDo(action, s.status)).map((s) => s.id);
}
