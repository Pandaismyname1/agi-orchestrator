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

// ── automation rules as edges ──────────────────────────────────────────────────

/** The slice of an automation rule the graph reads (structural; AutomationRule satisfies it). */
export interface AutomationRuleLike {
  id?: string;
  name?: string;
  enabled?: boolean;
  on?: string[];
  match?: { sessionId?: string };
  actions?: { kind: string; target?: string }[];
}

/**
 * An automation rendered as a canvas edge: a rule that, when `from` fires a
 * lifecycle event, starts or stops a concrete `to` session. Distinct from a
 * dependency edge — it's a reactive trigger, not a prerequisite.
 */
export interface AutomationEdge {
  from: string;
  to: string;
  kind: "start" | "stop";
  events: string[];
  ruleId: string;
  ruleName: string;
}

/** Does an automation edge `from → to` (optionally of a given kind) already exist? */
export function hasAutomationEdge(
  rules: AutomationRuleLike[] | undefined,
  from: string,
  to: string,
  kind?: "start" | "stop",
): boolean {
  return deriveAutomationEdges(rules, [from, to]).some(
    (e) => e.from === from && e.to === to && (!kind || e.kind === kind),
  );
}

/**
 * Derive the automation edges that connect two distinct, known sessions: a rule
 * scoped to a specific firing session (`match.sessionId`) whose start/stop action
 * targets another concrete session (not `$self`). Rules without a concrete
 * source+target (any-session matches, `$self`, notify-only) aren't drawable edges
 * and are skipped. Disabled rules are skipped. Deduped by from|to|kind.
 */
export function deriveAutomationEdges(
  rules: AutomationRuleLike[] | undefined,
  knownIds: string[] | Set<string>,
): AutomationEdge[] {
  if (!rules || rules.length === 0) return [];
  const ids = knownIds instanceof Set ? knownIds : new Set(knownIds);
  const out: AutomationEdge[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (r.enabled === false) continue;
    const from = r.match?.sessionId;
    if (!from || !ids.has(from)) continue;
    for (const a of r.actions ?? []) {
      if (a.kind !== "start" && a.kind !== "stop") continue;
      const to = a.target;
      if (!to || to === "$self" || to === from || !ids.has(to)) continue;
      const key = `${from}|${to}|${a.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        from,
        to,
        kind: a.kind,
        events: r.on ?? [],
        ruleId: r.id ?? key,
        ruleName: r.name ?? "automation",
      });
    }
  }
  return out;
}

// ── canvas zoom helpers ───────────────────────────────────────────────────────
// Pure math for the workflow builder's zoom control: clamping and fit-to-view.
// Kept here (no DOM) so the bounds and fit calculation are unit-testable.

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 1.6;

/** Clamp a zoom factor into [ZOOM_MIN, ZOOM_MAX]; non-finite → 1. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Step the zoom by `dir` (+1 in / -1 out) `step` units, clamped. */
export function stepZoom(z: number, dir: number, step = 0.15): number {
  return clampZoom(clampZoom(z) + (dir >= 0 ? step : -step));
}

/**
 * Scale that fits content (contentW×contentH) inside a viewport (viewW×viewH),
 * minus `pad` of breathing room. Never zooms IN past 100% (fit only shrinks),
 * and is clamped to the zoom bounds. Degenerate inputs → 1.
 */
export function fitScale(
  contentW: number,
  contentH: number,
  viewW: number,
  viewH: number,
  pad = 24,
): number {
  if (contentW <= 0 || contentH <= 0 || viewW <= 0 || viewH <= 0) return 1;
  const s = Math.min((viewW - pad) / contentW, (viewH - pad) / contentH);
  return clampZoom(Math.min(1, s));
}
