/**
 * Persisted fleet view preferences (sort key + filter query). Pure parse/serialize
 * with validation so the persistence logic is unit-testable without a DOM; the
 * load/save wrappers touch localStorage behind try/catch (private mode / disabled
 * storage degrade to defaults rather than throwing).
 */
import { SORT_OPTIONS, type SortKey } from "./sort";

export interface FleetPrefs {
  sortKey: SortKey;
  query: string;
}

const KEY = "agi.fleet.prefs.v1";
const DEFAULT_SORT: SortKey = "attention";
const VALID_SORT = new Set<string>(SORT_OPTIONS.map((o) => o.key));
const MAX_QUERY = 200;

export const defaultFleetPrefs = (): FleetPrefs => ({ sortKey: DEFAULT_SORT, query: "" });

/** Coerce an unknown value to a valid SortKey, falling back to the default. */
export function coerceSortKey(v: unknown): SortKey {
  return typeof v === "string" && VALID_SORT.has(v) ? (v as SortKey) : DEFAULT_SORT;
}

/** Parse stored JSON into validated prefs. Bad/empty input → defaults (never throws). */
export function parseFleetPrefs(raw: string | null | undefined): FleetPrefs {
  if (!raw) return defaultFleetPrefs();
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      sortKey: coerceSortKey(o?.sortKey),
      query: typeof o?.query === "string" ? o.query.slice(0, MAX_QUERY) : "",
    };
  } catch {
    return defaultFleetPrefs();
  }
}

/** Serialize prefs to the stored JSON shape (query clamped to a sane length). */
export function serializeFleetPrefs(p: FleetPrefs): string {
  return JSON.stringify({ sortKey: coerceSortKey(p.sortKey), query: (p.query ?? "").slice(0, MAX_QUERY) });
}

/** Read persisted prefs from localStorage (defaults if unavailable). */
export function loadFleetPrefs(): FleetPrefs {
  try {
    return parseFleetPrefs(localStorage.getItem(KEY));
  } catch {
    return defaultFleetPrefs();
  }
}

/** Persist prefs to localStorage (no-op if storage is unavailable). */
export function saveFleetPrefs(p: FleetPrefs): void {
  try {
    localStorage.setItem(KEY, serializeFleetPrefs(p));
  } catch {
    /* private mode / storage disabled — fine, just won't persist */
  }
}
