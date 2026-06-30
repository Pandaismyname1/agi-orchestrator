/**
 * Fleet search/filter — pure matching logic (no Svelte deps) so it's unit-testable.
 *
 * A query is split into space-separated terms; a session matches only if EVERY
 * term is a case-insensitive substring of its searchable text (id/label, goal,
 * cwd, status, mode, autonomy, permission mode). AND-across-terms lets you narrow
 * with multiple words ("api running", "deploy needs").
 */

/** The subset of a session the filter reads. SessionView structurally satisfies it. */
export interface FilterableSession {
  id: string;
  goal?: string;
  cwd?: string;
  status?: string;
  mode?: string;
  autonomy?: string;
  permissionMode?: string;
}

/** The lowercased searchable text for a session. */
export function sessionHaystack(s: FilterableSession): string {
  return [s.id, s.goal, s.cwd, s.status, s.mode, s.autonomy, s.permissionMode]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Split a raw query into normalized lowercase terms. */
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** True if every query term is found in the session's searchable text. */
export function matchesQuery(s: FilterableSession, query: string): boolean {
  const terms = queryTerms(query);
  if (terms.length === 0) return true;
  const hay = sessionHaystack(s);
  return terms.every((t) => hay.includes(t));
}

/** Filter a session list by a query (returns the same array reference when the query is empty). */
export function filterSessions<T extends FilterableSession>(sessions: T[], query: string): T[] {
  if (!query.trim()) return sessions;
  return sessions.filter((s) => matchesQuery(s, query));
}
