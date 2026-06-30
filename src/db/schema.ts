/**
 * SQLite schema for the orchestrator's local persistent store (`agi.db`).
 *
 * Tier 0 populates: sessions, runs, turns, decisions, events.
 * Created-but-empty now, wired in later tiers: attention_requests (T1 escalation),
 * preferences (T3 learning).
 *
 * Timestamps are unix-epoch milliseconds (INTEGER). The JSONL transcript stays
 * the source of truth for raw message content; this DB is the structured record
 * of runs/turns/decisions for history, resume, and analytics.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  label           TEXT,
  cwd             TEXT NOT NULL,
  goal            TEXT NOT NULL,
  done_criteria   TEXT NOT NULL,
  permission_mode TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  status            TEXT NOT NULL,              -- running | ended | error
  stop_reason       TEXT,
  turns             INTEGER NOT NULL DEFAULT 0,
  elapsed_min       REAL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS turns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER NOT NULL,
  n               INTEGER NOT NULL,
  injected_prompt TEXT,
  assistant_text  TEXT,
  duration_ms     INTEGER,
  gates_handled   INTEGER NOT NULL DEFAULT 0,
  files_changed   INTEGER,                         -- # files the agent changed this turn (git)
  diff            TEXT,                            -- per-turn unified diff (JSON: {files, patch, truncated})
  snapshot        TEXT,                            -- pinned git sha of the worktree after this turn (rollback target)
  created_at      INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id     INTEGER NOT NULL,
  action      TEXT NOT NULL,                    -- continue | stop
  prompt      TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES turns(id)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  run_id      INTEGER,
  type        TEXT NOT NULL,
  payload     TEXT,                             -- JSON
  created_at  INTEGER NOT NULL
);

-- Ready for Tier 1 (human-decision escalation). Unused in Tier 0.
CREATE TABLE IF NOT EXISTS attention_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER,
  turn_id       INTEGER,
  kind          TEXT,
  summary       TEXT,
  options       TEXT,                           -- JSON array of {label, rationale, prompt}
  chosen_option TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- open | resolved | timed_out
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER
);

-- Ready for Tier 3 (learning loop). Unused in Tier 0.
CREATE TABLE IF NOT EXISTS preferences (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  scope       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_session   ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_run      ON turns(run_id);
CREATE INDEX IF NOT EXISTS idx_decisions_turn ON decisions(turn_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`;
