/**
 * Store — the local SQLite persistence layer (Tier 0).
 *
 * Wraps Node 24's built-in `node:sqlite` (synchronous, zero native build). One
 * `agi.db` file holds sessions / runs / turns / decisions / events so history,
 * resume, and analytics survive daemon restarts.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { SCHEMA } from "./schema.js";
import type { SessionConfig } from "../types.js";

// node:sqlite is still flagged experimental and prints a warning on first use.
// It's stable enough for a local tool — silence just that one warning.
const _origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : warning?.message ?? "";
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return (_origEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export interface RunRow {
  id: number;
  session_id: string;
  status: "running" | "ended" | "error";
  stop_reason: string | null;
  turns: number;
  elapsed_min: number | null;
  started_at: number;
  ended_at: number | null;
}

export interface TurnRow {
  id: number;
  run_id: number;
  n: number;
  injected_prompt: string | null;
  assistant_text: string | null;
  duration_ms: number | null;
  gates_handled: number;
  created_at: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(path.resolve(dbPath));
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- sessions -----------------------------------------------------------

  upsertSession(s: SessionConfig): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, label, cwd, goal, done_criteria, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label=excluded.label, cwd=excluded.cwd, goal=excluded.goal,
           done_criteria=excluded.done_criteria, permission_mode=excluded.permission_mode,
           updated_at=excluded.updated_at`,
      )
      .run(s.id, s.id, s.cwd, s.goal, s.doneCriteria, s.permissionMode ?? null, now, now);
  }

  // ---- runs ---------------------------------------------------------------

  startRun(sessionId: string): number {
    const r = this.db
      .prepare(`INSERT INTO runs (session_id, status, started_at) VALUES (?, 'running', ?)`)
      .run(sessionId, Date.now());
    return Number(r.lastInsertRowid);
  }

  endRun(
    runId: number,
    status: "ended" | "error",
    opts: { stopReason?: string; turns?: number; elapsedMin?: number },
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET status=?, stop_reason=?, turns=?, elapsed_min=?, ended_at=? WHERE id=?`,
      )
      .run(
        status,
        opts.stopReason ?? null,
        opts.turns ?? 0,
        opts.elapsedMin ?? null,
        Date.now(),
        runId,
      );
  }

  // ---- turns / decisions --------------------------------------------------

  addTurn(
    runId: number,
    t: { n: number; prompt: string; assistantText: string; durationMs: number; gatesHandled: number },
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO turns (run_id, n, injected_prompt, assistant_text, duration_ms, gates_handled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, t.n, t.prompt, t.assistantText, t.durationMs, t.gatesHandled, Date.now());
    return Number(r.lastInsertRowid);
  }

  addDecision(turnId: number, d: { action: string; prompt?: string; reason: string }): void {
    this.db
      .prepare(`INSERT INTO decisions (turn_id, action, prompt, reason, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(turnId, d.action, d.prompt ?? null, d.reason, Date.now());
  }

  // ---- attention (human-decision escalation) ------------------------------

  addAttentionRequest(
    runId: number | undefined,
    turnId: number | undefined,
    req: { question: string; options: unknown },
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO attention_requests (run_id, turn_id, kind, summary, options, status, created_at)
         VALUES (?, ?, 'decision', ?, ?, 'open', ?)`,
      )
      .run(runId ?? null, turnId ?? null, req.question, JSON.stringify(req.options ?? []), Date.now());
    return Number(r.lastInsertRowid);
  }

  resolveAttentionRequest(rowId: number, chosen: string, status: "resolved" | "timed_out" = "resolved"): void {
    this.db
      .prepare(`UPDATE attention_requests SET status=?, chosen_option=?, resolved_at=? WHERE id=?`)
      .run(status, chosen, Date.now(), rowId);
  }

  // ---- events -------------------------------------------------------------

  addEvent(e: { sessionId?: string; runId?: number; type: string; payload?: unknown }): void {
    this.db
      .prepare(`INSERT INTO events (session_id, run_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(
        e.sessionId ?? null,
        e.runId ?? null,
        e.type,
        e.payload === undefined ? null : JSON.stringify(e.payload),
        Date.now(),
      );
  }

  // ---- reads (for verification, history, analytics) -----------------------

  getSessions(): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all() as Array<
      Record<string, unknown>
    >;
  }

  getRuns(sessionId?: string, limit = 50): RunRow[] {
    const sql = sessionId
      ? `SELECT * FROM runs WHERE session_id=? ORDER BY id DESC LIMIT ?`
      : `SELECT * FROM runs ORDER BY id DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    return (sessionId ? stmt.all(sessionId, limit) : stmt.all(limit)) as unknown as RunRow[];
  }

  getRun(id: number): RunRow | null {
    return (this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as unknown as RunRow) ?? null;
  }

  getTurns(runId: number): TurnRow[] {
    return this.db
      .prepare(`SELECT * FROM turns WHERE run_id=? ORDER BY n ASC`)
      .all(runId) as unknown as TurnRow[];
  }

  /** Total turns + wall-clock minutes across all runs started since `sinceMs`. */
  usageSince(sinceMs: number): { turns: number; minutes: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(turns),0) AS turns, COALESCE(SUM(elapsed_min),0) AS minutes
         FROM runs WHERE started_at >= ?`,
      )
      .get(sinceMs) as { turns: number; minutes: number };
    return row;
  }

  /** Per-session aggregate stats for an analytics view. */
  sessionStats(sessionId: string): { runs: number; totalTurns: number; lastRunAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(turns),0) AS totalTurns, MAX(started_at) AS lastRunAt
         FROM runs WHERE session_id=?`,
      )
      .get(sessionId) as { runs: number; totalTurns: number; lastRunAt: number | null };
    return row;
  }

  // ---- observability (history / timeline / metrics) -----------------------

  /** A run's decisions, keyed by the turn number they followed. */
  getDecisions(runId: number): Array<{ n: number; action: string; prompt: string | null; reason: string | null }> {
    return this.db
      .prepare(
        `SELECT t.n AS n, d.action AS action, d.prompt AS prompt, d.reason AS reason
         FROM decisions d JOIN turns t ON d.turn_id = t.id
         WHERE t.run_id = ? ORDER BY t.n ASC`,
      )
      .all(runId) as Array<{ n: number; action: string; prompt: string | null; reason: string | null }>;
  }

  /** A run's raw event log (start/turn/decision/attention/gate/stop/…). */
  getEvents(runId: number): Array<{ type: string; payload: string | null; created_at: number }> {
    return this.db
      .prepare(`SELECT type, payload, created_at FROM events WHERE run_id = ? ORDER BY id ASC`)
      .all(runId) as Array<{ type: string; payload: string | null; created_at: number }>;
  }

  /** Aggregate metrics for the dashboard (optionally scoped to one session). */
  metrics(sessionId?: string): {
    runs: number;
    turns: number;
    avgTurns: number;
    interventionRuns: number;
    interventionRate: number;
    byStatus: Record<string, number>;
  } {
    const where = sessionId ? `WHERE session_id = ?` : ``;
    const args = sessionId ? [sessionId] : [];
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(turns),0) AS turns FROM runs ${where}`)
      .get(...args) as { runs: number; turns: number };

    const statusRows = this.db
      .prepare(`SELECT status, COUNT(*) AS c FROM runs ${where} GROUP BY status`)
      .all(...args) as Array<{ status: string; c: number }>;
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.c;

    // Runs that required a human (had an attention or gate event).
    const intvWhere = sessionId ? `AND r.session_id = ?` : ``;
    const intv = this.db
      .prepare(
        `SELECT COUNT(DISTINCT e.run_id) AS c FROM events e JOIN runs r ON e.run_id = r.id
         WHERE e.type IN ('attention','gate') ${intvWhere}`,
      )
      .get(...args) as { c: number };

    return {
      runs: agg.runs,
      turns: agg.turns,
      avgTurns: agg.runs ? Number((agg.turns / agg.runs).toFixed(1)) : 0,
      interventionRuns: intv.c,
      interventionRate: agg.runs ? Number((intv.c / agg.runs).toFixed(2)) : 0,
      byStatus,
    };
  }

  // ---- preferences (key/value store; backs the learning loop, A3) ---------

  /** Read one preference row, or null. `value` is an opaque (often JSON) string. */
  getPreference(key: string): { value: string; scope: string | null; updated_at: number } | null {
    return (
      (this.db
        .prepare(`SELECT value, scope, updated_at FROM preferences WHERE key = ?`)
        .get(key) as { value: string; scope: string | null; updated_at: number } | undefined) ?? null
    );
  }

  /** Upsert a preference (the value is stored verbatim — JSON-encode before calling). */
  setPreference(key: string, value: string, scope?: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO preferences (key, value, scope, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value, scope=excluded.scope, updated_at=excluded.updated_at`,
      )
      .run(key, value, scope ?? null, now, now);
  }

  deletePreference(key: string): void {
    this.db.prepare(`DELETE FROM preferences WHERE key = ?`).run(key);
  }

  /** All preferences whose key starts with `prefix` (e.g. "profile.version.global."). */
  listPreferences(
    prefix: string,
  ): Array<{ key: string; value: string; scope: string | null; updated_at: number }> {
    return this.db
      .prepare(
        `SELECT key, value, scope, updated_at FROM preferences WHERE key LIKE ? ESCAPE '\\' ORDER BY key ASC`,
      )
      .all(prefix.replace(/[%_\\]/g, "\\$&") + "%") as Array<{
      key: string;
      value: string;
      scope: string | null;
      updated_at: number;
    }>;
  }
}

/** Open (creating if needed) the store at the given path. */
export function openStore(dbPath: string): Store {
  return new Store(dbPath);
}
