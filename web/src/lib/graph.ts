/**
 * Workflow-graph logic — pure, no Svelte/DOM deps, so it's unit-testable.
 *
 * Sessions are nodes; a session's `dependsOn` ids are its incoming edges. An edge
 * is written `from → to` meaning "`to` runs after `from`" (so `from` is an id in
 * `to.dependsOn`). The builder UI renders these and lets the operator add/remove
 * them; the backend is the source of truth and re-validates (cycles, unknown ids).
 */

/** The slice of a session the graph reads. SessionView structurally satisfies it. */
export interface GraphSession {
  id: string;
  dependsOn?: string[];
}

/** A directed dependency edge: `to` runs after `from`. */
export interface GraphEdge {
  from: string;
  to: string;
}

/** Every dependency edge in the fleet (both endpoints must exist). */
export function deriveEdges(sessions: GraphSession[]): GraphEdge[] {
  const ids = new Set(sessions.map((s) => s.id));
  const edges: GraphEdge[] = [];
  for (const s of sessions) {
    for (const dep of s.dependsOn ?? []) {
      if (ids.has(dep) && dep !== s.id) edges.push({ from: dep, to: s.id });
    }
  }
  return edges;
}

/**
 * Longest-path "level" for each node (roots at 0): a node sits one column right
 * of its deepest dependency. Cycle-guarded so a malformed snapshot can't wedge
 * the layout (a node caught in a cycle just resolves to 0).
 */
export function levelize(sessions: GraphSession[]): Map<string, number> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const lvl = (id: string): number => {
    if (level.has(id)) return level.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d) && d !== id);
    const v = deps.length ? Math.max(...deps.map(lvl)) + 1 : 0;
    visiting.delete(id);
    level.set(id, v);
    return v;
  };
  for (const s of sessions) lvl(s.id);
  return level;
}

/** Position on the layered grid: column = dependency depth, row = order within column. */
export interface GridPos {
  col: number;
  row: number;
}

/** Layered auto-layout: map each session id to a {col,row} grid cell. */
export function layeredLayout(sessions: GraphSession[]): Map<string, GridPos> {
  const level = levelize(sessions);
  const rowByCol = new Map<number, number>();
  const pos = new Map<string, GridPos>();
  for (const s of sessions) {
    const col = level.get(s.id) ?? 0;
    const row = rowByCol.get(col) ?? 0;
    rowByCol.set(col, row + 1);
    pos.set(s.id, { col, row });
  }
  return pos;
}

/** True if `goal` is reachable from `start` by following `dependsOn` edges. */
export function reachableViaDeps(sessions: GraphSession[], start: string, goal: string): boolean {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === goal) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of byId.get(cur)?.dependsOn ?? []) stack.push(d);
  }
  return false;
}

/**
 * Would adding the edge `from → to` (i.e. `to` runs after `from`) create a cycle?
 * That happens when `from` already (transitively) runs after `to` — or it's a
 * self-edge. Mirrors the backend's cycle guard so the UI can refuse early.
 */
export function wouldCreateCycle(sessions: GraphSession[], from: string, to: string): boolean {
  if (from === to) return true;
  return reachableViaDeps(sessions, from, to);
}

/** Does the edge `from → to` already exist (`from` is in `to.dependsOn`)? */
export function hasEdge(sessions: GraphSession[], from: string, to: string): boolean {
  const dependent = sessions.find((s) => s.id === to);
  return !!dependent?.dependsOn?.includes(from);
}

/** New `dependsOn` for `to` after adding the edge `from → to` (deduped). */
export function withDependency(sessions: GraphSession[], from: string, to: string): string[] {
  const cur = sessions.find((s) => s.id === to)?.dependsOn ?? [];
  return cur.includes(from) ? [...cur] : [...cur, from];
}

/** New `dependsOn` for `to` after removing the edge `from → to`. */
export function withoutDependency(sessions: GraphSession[], from: string, to: string): string[] {
  const cur = sessions.find((s) => s.id === to)?.dependsOn ?? [];
  return cur.filter((d) => d !== from);
}
