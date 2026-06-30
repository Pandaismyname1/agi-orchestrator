/**
 * Fleet sort — pure ordering logic (no Svelte deps) so it's unit-testable.
 *
 * The default "attention" order floats sessions that need a human to the top
 * (error → needs-input → blocked → active → … → done), which is what an operator
 * scanning a busy fleet wants first. The other keys are plain field sorts. Every
 * sort is STABLE: ties keep the input order (decorate-with-index), so toggling
 * keys never scrambles equal rows.
 */

/** The subset of a session the sorter reads. SessionView structurally satisfies it. */
export interface SortableSession {
  id: string;
  status?: string;
  turns?: number;
  elapsedMin?: number;
}

export type SortKey = "attention" | "name" | "turns" | "runtime";

/** UI-facing list of sort options (key + short label), in menu order. */
export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "attention", label: "Attention" },
  { key: "name", label: "Name" },
  { key: "turns", label: "Most active" },
  { key: "runtime", label: "Longest running" },
];

/**
 * Attention ranking — lower sorts first. Anything needing a human (error,
 * needs-input, blocked) leads; finished/stopped work sinks. Unknown statuses
 * land in the middle so a new status never silently jumps to the top.
 */
const STATUS_RANK: Record<string, number> = {
  error: 0,
  "needs-input": 1,
  blocked: 2,
  running: 3,
  manual: 3,
  paused: 5,
  queued: 6,
  "rate-limited": 7,
  done: 8,
  stopped: 9,
  idle: 10,
};
const UNKNOWN_RANK = 4;

export function attentionRank(status?: string): number {
  if (!status) return UNKNOWN_RANK;
  return status in STATUS_RANK ? STATUS_RANK[status]! : UNKNOWN_RANK;
}

/** Compare two sessions by the given key (positive => a sorts after b). Stable ties → 0. */
function compare(a: SortableSession, b: SortableSession, key: SortKey): number {
  switch (key) {
    case "name":
      return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" });
    case "turns":
      return (b.turns ?? 0) - (a.turns ?? 0); // most active first
    case "runtime":
      return (b.elapsedMin ?? 0) - (a.elapsedMin ?? 0); // longest running first
    case "attention":
    default:
      return attentionRank(a.status) - attentionRank(b.status);
  }
}

/** Return a sorted COPY of the list (input is never mutated); ties keep input order. */
export function sortSessions<T extends SortableSession>(sessions: T[], key: SortKey): T[] {
  return sessions
    .map((s, i) => [s, i] as const)
    .sort((x, y) => compare(x[0], y[0], key) || x[1] - y[1])
    .map(([s]) => s);
}
