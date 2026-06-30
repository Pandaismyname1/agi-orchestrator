/**
 * Session scheduling (automation suite). Pure, deterministic helpers that decide
 * whether a session is "due" to auto-start — kept free of timers and clocks so
 * they're trivially unit-testable (the supervisor injects the current time).
 *
 * Two simple, composable triggers (no full cron — deliberately): run every N
 * minutes, and/or run daily at a local HH:MM. If both are set, either firing
 * makes the session due.
 */
import type { SessionSchedule } from "../types.js";

/** Parse a "HH:MM" (24h) string. Returns null if malformed or out of range. */
export function parseHHMM(s: string | undefined): { h: number; m: number } | null {
  if (!s) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/**
 * The most recent local HH:MM boundary at or before `now` (epoch ms). If today's
 * HH:MM hasn't happened yet, returns yesterday's. Uses local time (the operator's
 * wall clock), matching how a person reads "run at 2am".
 */
export function lastDailyBoundary(now: number, h: number, m: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
  if (today <= now) return today;
  return today - 24 * 60 * 60_000; // yesterday's boundary
}

/**
 * Is `schedule` due to fire at `now`, given the last time it fired (`lastFire`,
 * epoch ms — seed it with "scheduler start" so nothing fires before its first
 * window)? A disabled or empty schedule is never due.
 */
export function isDue(schedule: SessionSchedule | undefined, now: number, lastFire: number): boolean {
  if (!schedule || schedule.enabled === false) return false;
  let due = false;

  if (typeof schedule.everyMinutes === "number" && schedule.everyMinutes >= 1) {
    due = due || now - lastFire >= schedule.everyMinutes * 60_000;
  }

  const hhmm = parseHHMM(schedule.dailyAt);
  if (hhmm) {
    const boundary = lastDailyBoundary(now, hhmm.h, hhmm.m);
    // Due if a daily boundary fell strictly after the last fire (i.e. we crossed
    // the scheduled time since we last ran) and we've actually reached it.
    due = due || (boundary > lastFire && boundary <= now);
  }

  return due;
}

/** True if a schedule has at least one active trigger configured (and is enabled). */
export function hasActiveTrigger(schedule: SessionSchedule | undefined): boolean {
  if (!schedule || schedule.enabled === false) return false;
  const everyOk = typeof schedule.everyMinutes === "number" && schedule.everyMinutes >= 1;
  return everyOk || parseHHMM(schedule.dailyAt) !== null;
}

/** Short human description of a schedule, e.g. "every 30m · daily 02:00". */
export function describeSchedule(schedule: SessionSchedule | undefined): string {
  if (!schedule) return "";
  const parts: string[] = [];
  if (typeof schedule.everyMinutes === "number" && schedule.everyMinutes >= 1) {
    parts.push(`every ${schedule.everyMinutes}m`);
  }
  const hhmm = parseHHMM(schedule.dailyAt);
  if (hhmm) parts.push(`daily ${String(hhmm.h).padStart(2, "0")}:${String(hhmm.m).padStart(2, "0")}`);
  const desc = parts.join(" · ");
  if (!desc) return "";
  return schedule.enabled === false ? `${desc} (paused)` : desc;
}
