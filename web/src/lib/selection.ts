/**
 * Bulk-action helpers — pure logic for which selected sessions can take a given
 * action, so the toolbar can show accurate counts and skip no-ops. No Svelte deps
 * (unit-testable).
 *
 * - start: a session that isn't already active or queued (idle/stopped/done/
 *   error/blocked) — starting it kicks off a run (or queues it).
 * - stop: a session that's active or pending (running/manual/needs-input/paused/
 *   queued/blocked) — stopping halts it or removes it from the queue.
 * - delete: any session that isn't actively running (the backend refuses to
 *   delete a running session; everything else can be removed, with undo).
 */

/** Minimal shape the bulk helpers read. SessionView satisfies it. */
export interface SelectableSession {
  id: string;
  status?: string;
}

export type BulkAction = "start" | "stop" | "delete";

const STARTABLE = new Set(["idle", "stopped", "done", "error", "blocked"]);
const STOPPABLE = new Set(["running", "manual", "needs-input", "paused", "queued", "blocked"]);

export function canStart(status: string | undefined): boolean {
  return !!status && STARTABLE.has(status);
}
export function canStop(status: string | undefined): boolean {
  return !!status && STOPPABLE.has(status);
}
/** Deletable = anything that isn't actively running (matches the backend guard). */
export function canDelete(status: string | undefined): boolean {
  return status !== "running";
}
export function canDo(action: BulkAction, status: string | undefined): boolean {
  if (action === "start") return canStart(status);
  if (action === "stop") return canStop(status);
  return canDelete(status);
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

/** Minimal shape for dependency-aware ordering. SessionView satisfies it. */
export interface DependentSession {
  id: string;
  dependsOn?: string[];
}

/**
 * Order sessions so each appears AFTER every dependency that's also in the set.
 * Used when re-creating bulk-deleted sessions on undo: the backend drops a
 * `dependsOn` entry whose target doesn't exist yet, so a dependent must be
 * re-added after its (also-deleted) dependency to preserve the edge. Stable
 * (DFS post-order over input order) and cycle-tolerant (best-effort).
 */
export function orderByDeps<T extends DependentSession>(items: T[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: T[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (item: T): void => {
    if (placed.has(item.id) || visiting.has(item.id)) return; // done or in a cycle
    visiting.add(item.id);
    for (const dep of item.dependsOn ?? []) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    visiting.delete(item.id);
    placed.add(item.id);
    out.push(item);
  };
  for (const item of items) visit(item);
  return out;
}
