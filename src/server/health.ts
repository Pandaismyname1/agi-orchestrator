/**
 * System health / diagnostics (operator experience). An unattended orchestrator
 * needs a one-glance answer to "is everything healthy?": is the local brain
 * reachable, is the store sound, how long have we been up, is any session wedged.
 *
 * `buildHealth` is a PURE function over already-gathered inputs (unit-testable);
 * `Supervisor.health()` does the actual probing and calls it. The overall status
 * is the worst of: brain reachability (critical) and errored sessions (degraded).
 */

export interface HealthInput {
  /** Current epoch ms. */
  now: number;
  /** Epoch ms the supervisor booted (for uptime). */
  bootAt: number;
  version: string;
  llm: { ok: boolean; detail: string; model: string; baseUrl: string };
  db: { path: string; sizeBytes: number; sessions: number; runs: number };
  fleet: { total: number; running: number; needsInput: number; error: number };
}

export type HealthStatus = "ok" | "degraded" | "down";

export interface HealthReport {
  /** Worst-of roll-up: down (brain unreachable) > degraded (errored sessions) > ok. */
  status: HealthStatus;
  version: string;
  /** Whole seconds since boot. */
  uptimeSec: number;
  llm: { ok: boolean; detail: string; model: string; baseUrl: string };
  db: { path: string; sizeBytes: number; sessions: number; runs: number };
  fleet: { total: number; running: number; needsInput: number; error: number };
  /** When this report was computed (= input.now). */
  checkedAt: number;
}

/** Roll up the inputs into a single report with an overall status. */
export function buildHealth(input: HealthInput): HealthReport {
  const status: HealthStatus = !input.llm.ok ? "down" : input.fleet.error > 0 ? "degraded" : "ok";
  return {
    status,
    version: input.version,
    uptimeSec: Math.max(0, Math.floor((input.now - input.bootAt) / 1000)),
    llm: input.llm,
    db: input.db,
    fleet: input.fleet,
    checkedAt: input.now,
  };
}
