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

  getTurns(runId: number): TurnRow[] {
    return this.db
      .prepare(`SELECT * FROM turns WHERE run_id=? ORDER BY n ASC`)
      .all(runId) as unknown as TurnRow[];
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
}

/** Open (creating if needed) the store at the given path. */
export function openStore(dbPath: string): Store {
  return new Store(dbPath);
}
