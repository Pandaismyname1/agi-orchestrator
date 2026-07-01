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
  files_changed: number | null;
  /** JSON-encoded TurnDiff ({files, patch, truncated}) or null. */
  diff: string | null;
  /** Pinned git sha of the worktree after this turn (rollback target) or null. */
  snapshot: string | null;
  created_at: number;
}

export interface AttentionRow {
  id: number;
  turn_id: number | null;
  summary: string | null;
  options: string | null;
  chosen_option: string | null;
  status: string;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(path.resolve(dbPath));
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Idempotent column adds for DBs created before a column existed. */
  private migrate(): void {
    for (const col of ["files_changed INTEGER", "diff TEXT", "snapshot TEXT"]) {
      try {
        this.db.exec(`ALTER TABLE turns ADD COLUMN ${col}`);
      } catch {
        // already present — node:sqlite throws "duplicate column name"; ignore.
      }
    }
    try {
      this.db.exec(`ALTER TABLE decisions ADD COLUMN feedback TEXT`);
    } catch {
      // already present — ignore.
    }
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
    t: {
      n: number;
      prompt: string;
      assistantText: string;
      durationMs: number;
      gatesHandled: number;
      filesChanged?: number | null;
      diff?: string | null;
      snapshot?: string | null;
    },
  ): number {
    const r = this.db
      .prepare(
        `INSERT INTO turns (run_id, n, injected_prompt, assistant_text, duration_ms, gates_handled, files_changed, diff, snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        t.n,
        t.prompt,
        t.assistantText,
        t.durationMs,
        t.gatesHandled,
        t.filesChanged ?? null,
        t.diff ?? null,
        t.snapshot ?? null,
        Date.now(),
      );
    return Number(r.lastInsertRowid);
  }

  /**
   * True if `sha` is a per-turn snapshot recorded for ANY run of `sessionId`.
   * Gates rollback so a client can only restore to a snapshot this session
   * actually produced (not an arbitrary sha).
   */
  snapshotBelongsToSession(sessionId: string, sha: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM turns t JOIN runs r ON r.id = t.run_id
         WHERE r.session_id = ? AND t.snapshot = ? LIMIT 1`,
      )
      .get(sessionId, sha);
    return !!row;
  }

  addDecision(turnId: number, d: { action: string; prompt?: string; reason: string }): void {
    this.db
      .prepare(`INSERT INTO decisions (turn_id, action, prompt, reason, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(turnId, d.action, d.prompt ?? null, d.reason, Date.now());
  }

  // ---- decision feedback (operator thumbs up/down; learning loop, T3) ------

  /**
   * Rate the MOST RECENT decision recorded for a session (the one the live
   * dashboard shows). `feedback` is 'up' | 'down' | null (null clears it).
   * Returns the run id + turn number that was rated, or null if the session has
   * no decisions yet. Resolves the latest decision via runs → turns → decisions.
   */
  setLatestDecisionFeedback(
    sessionId: string,
    feedback: "up" | "down" | null,
  ): { runId: number; turnN: number } | null {
    const row = this.db
      .prepare(
        `SELECT d.id AS decId, r.id AS runId, t.n AS turnN
         FROM decisions d JOIN turns t ON d.turn_id = t.id JOIN runs r ON t.run_id = r.id
         WHERE r.session_id = ? ORDER BY d.id DESC LIMIT 1`,
      )
      .get(sessionId) as { decId: number; runId: number; turnN: number } | undefined;
    if (!row) return null;
    this.db.prepare(`UPDATE decisions SET feedback = ? WHERE id = ?`).run(feedback, row.decId);
    return { runId: row.runId, turnN: row.turnN };
  }

  /**
   * Rate the decision that followed turn `turnN` of `runId`, but only if that run
   * belongs to `sessionId` (so a client can't rate another session's decisions).
   * Returns true if a row was updated.
   */
  setDecisionFeedback(
    sessionId: string,
    runId: number,
    turnN: number,
    feedback: "up" | "down" | null,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE decisions SET feedback = ?
         WHERE turn_id = (
           SELECT t.id FROM turns t JOIN runs r ON t.run_id = r.id
           WHERE r.id = ? AND t.n = ? AND r.session_id = ?
         )`,
      )
      .run(feedback, runId, turnN, sessionId);
    return Number(r.changes) > 0;
  }

  /** Decision-action counts (continue/stop/escalate) for a session or the fleet. */
  decisionBreakdown(sessionId?: string): { continue: number; stop: number; escalate: number } {
    const where = sessionId ? `WHERE r.session_id = ?` : ``;
    const args = sessionId ? [sessionId] : [];
    const rows = this.db
      .prepare(
        `SELECT d.action AS action, COUNT(*) AS c
         FROM decisions d JOIN turns t ON d.turn_id = t.id JOIN runs r ON t.run_id = r.id
         ${where} GROUP BY d.action`,
      )
      .all(...args) as Array<{ action: string; c: number }>;
    const out = { continue: 0, stop: 0, escalate: 0 };
    for (const r of rows) {
      if (r.action === "continue") out.continue = r.c;
      else if (r.action === "stop") out.stop = r.c;
      else if (r.action === "escalate") out.escalate = r.c;
    }
    return out;
  }

  /**
   * Per-turn latencies (ms) for a session (or the whole fleet), oldest first.
   * Only non-null, positive durations — feeds the latency percentiles in analytics.
   */
  turnDurations(sessionId?: string): number[] {
    const where = sessionId ? `WHERE r.session_id = ?` : ``;
    const args = sessionId ? [sessionId] : [];
    const rows = this.db
      .prepare(
        `SELECT t.duration_ms AS d
         FROM turns t JOIN runs r ON t.run_id = r.id
         ${where ? where + " AND" : "WHERE"} t.duration_ms IS NOT NULL AND t.duration_ms > 0
         ORDER BY t.id ASC`,
      )
      .all(...args) as Array<{ d: number }>;
    return rows.map((r) => r.d);
  }

  /** Per-day run + turn counts since `sinceMs` (local dates), oldest first. */
  dailyActivity(sinceMs: number, sessionId?: string): Array<{ day: string; runs: number; turns: number }> {
    const extra = sessionId ? `AND session_id = ?` : ``;
    const args = sessionId ? [sinceMs, sessionId] : [sinceMs];
    return this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS runs, COALESCE(SUM(turns), 0) AS turns
         FROM runs WHERE started_at >= ? ${extra}
         GROUP BY day ORDER BY day ASC`,
      )
      .all(...args) as Array<{ day: string; runs: number; turns: number }>;
  }

  /** Thumbs tally for a session (optionally all sessions when omitted). */
  feedbackStats(sessionId?: string): { up: number; down: number } {
    const where = sessionId ? `AND r.session_id = ?` : ``;
    const args = sessionId ? [sessionId] : [];
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN d.feedback = 'up' THEN 1 ELSE 0 END), 0) AS up,
           COALESCE(SUM(CASE WHEN d.feedback = 'down' THEN 1 ELSE 0 END), 0) AS down
         FROM decisions d JOIN turns t ON d.turn_id = t.id JOIN runs r ON t.run_id = r.id
         WHERE 1=1 ${where}`,
      )
      .get(...args) as { up: number; down: number };
    return { up: row.up, down: row.down };
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

  /**
   * A run's escalation rows (for the learning loop). `chosen_option` holds the
   * label of the option the human picked; `options` is the JSON array the brain
   * offered ({label, rationale, prompt}) — joined back together in liveSignals.
   */
  getAttentions(runId: number): AttentionRow[] {
    return this.db
      .prepare(
        `SELECT id, turn_id, summary, options, chosen_option, status
         FROM attention_requests WHERE run_id=? ORDER BY id ASC`,
      )
      .all(runId) as unknown as AttentionRow[];
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

  /** The absolute cwd recorded for a session, or undefined if unknown. */
  sessionCwd(sessionId: string): string | undefined {
    const row = this.db.prepare(`SELECT cwd FROM sessions WHERE id = ?`).get(sessionId) as
      | { cwd: string | null }
      | undefined;
    return row?.cwd ?? undefined;
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
  getDecisions(
    runId: number,
  ): Array<{ n: number; action: string; prompt: string | null; reason: string | null; feedback: string | null }> {
    return this.db
      .prepare(
        `SELECT t.n AS n, d.action AS action, d.prompt AS prompt, d.reason AS reason, d.feedback AS feedback
         FROM decisions d JOIN turns t ON d.turn_id = t.id
         WHERE t.run_id = ? ORDER BY t.n ASC`,
      )
      .all(runId) as Array<{
      n: number;
      action: string;
      prompt: string | null;
      reason: string | null;
      feedback: string | null;
    }>;
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
