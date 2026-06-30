/**
 * Session analytics — aggregate the SQLite store into a per-session + fleet
 * performance report (runs, turns, success/intervention rates, decision mix,
 * operator thumbs, learning activity, daily trend) plus a CSV serializer for
 * export. Pure over the store reads, so it's unit-testable with a seeded DB.
 */
import type { Store } from "../db/store.js";
import type { LearningSummary } from "../learning/types.js";

export interface SessionAnalytics {
  id: string;
  goal: string;
  runs: number;
  turns: number;
  avgTurns: number;
  /** Runs that ended cleanly vs. errored (run-level status). */
  completedRuns: number;
  erroredRuns: number;
  /** completed / (completed + errored), 0 when none finished. */
  successRate: number;
  /** Fraction of runs that needed a human (attention/gate). */
  interventionRate: number;
  decisions: { continue: number; stop: number; escalate: number };
  feedback: { up: number; down: number };
  lastRunAt: number | null;
}

export interface FleetAnalytics {
  sessions: number;
  runs: number;
  turns: number;
  avgTurns: number;
  successRate: number;
  interventionRate: number;
  decisions: { continue: number; stop: number; escalate: number };
  feedback: { up: number; down: number };
}

export interface Analytics {
  generatedAt: number;
  fleet: FleetAnalytics;
  sessions: SessionAnalytics[];
  daily: Array<{ day: string; runs: number; turns: number }>;
  learning: { globalVersions: number; projectProfiles: number; totalExamples: number };
}

const rate = (num: number, den: number): number => (den > 0 ? Number((num / den).toFixed(2)) : 0);

/** Build the analytics report from the store (+ the learning summary). */
export function buildAnalytics(
  store: Store,
  learning: LearningSummary,
  opts: { nowMs: number; days?: number },
): Analytics {
  const days = opts.days ?? 30;
  const sinceMs = opts.nowMs - days * 24 * 60 * 60 * 1000;

  const sessionRows = store.getSessions();
  const sessions: SessionAnalytics[] = sessionRows.map((row) => {
    const id = String(row.id);
    const m = store.metrics(id);
    const stats = store.sessionStats(id);
    const completedRuns = m.byStatus.ended ?? 0;
    const erroredRuns = m.byStatus.error ?? 0;
    return {
      id,
      goal: typeof row.goal === "string" ? row.goal : "",
      runs: m.runs,
      turns: m.turns,
      avgTurns: m.avgTurns,
      completedRuns,
      erroredRuns,
      successRate: rate(completedRuns, completedRuns + erroredRuns),
      interventionRate: m.interventionRate,
      decisions: store.decisionBreakdown(id),
      feedback: store.feedbackStats(id),
      lastRunAt: stats.lastRunAt,
    };
  });
  // Busiest first, so the report leads with the agents doing the most work.
  sessions.sort((a, b) => b.runs - a.runs || b.turns - a.turns);

  const fm = store.metrics();
  const fleetCompleted = fm.byStatus.ended ?? 0;
  const fleetErrored = fm.byStatus.error ?? 0;
  const fleet: FleetAnalytics = {
    sessions: sessionRows.length,
    runs: fm.runs,
    turns: fm.turns,
    avgTurns: fm.avgTurns,
    successRate: rate(fleetCompleted, fleetCompleted + fleetErrored),
    interventionRate: fm.interventionRate,
    decisions: store.decisionBreakdown(),
    feedback: store.feedbackStats(),
  };

  const totalExamples =
    (learning.global.examples ?? 0) + learning.projects.reduce((s, p) => s + (p.examples ?? 0), 0);

  return {
    generatedAt: opts.nowMs,
    fleet,
    sessions,
    daily: store.dailyActivity(sinceMs),
    learning: {
      globalVersions: learning.global.versions ?? 0,
      projectProfiles: learning.projects.length,
      totalExamples,
    },
  };
}

/** Escape one CSV field (quote when it contains a comma, quote, or newline). */
function csvField(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Per-session CSV: one row per agent, with a leading FLEET total row. */
export function analyticsToCsv(a: Analytics): string {
  const header = [
    "session",
    "goal",
    "runs",
    "turns",
    "avg_turns",
    "completed_runs",
    "errored_runs",
    "success_rate",
    "intervention_rate",
    "decisions_continue",
    "decisions_stop",
    "decisions_escalate",
    "thumbs_up",
    "thumbs_down",
    "last_run_at",
  ];
  const rows: string[][] = [
    [
      "FLEET",
      "",
      String(a.fleet.runs),
      String(a.fleet.turns),
      String(a.fleet.avgTurns),
      "",
      "",
      String(a.fleet.successRate),
      String(a.fleet.interventionRate),
      String(a.fleet.decisions.continue),
      String(a.fleet.decisions.stop),
      String(a.fleet.decisions.escalate),
      String(a.fleet.feedback.up),
      String(a.fleet.feedback.down),
      "",
    ],
    ...a.sessions.map((s) => [
      s.id,
      s.goal,
      String(s.runs),
      String(s.turns),
      String(s.avgTurns),
      String(s.completedRuns),
      String(s.erroredRuns),
      String(s.successRate),
      String(s.interventionRate),
      String(s.decisions.continue),
      String(s.decisions.stop),
      String(s.decisions.escalate),
      String(s.feedback.up),
      String(s.feedback.down),
      s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "",
    ]),
  ];
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}
