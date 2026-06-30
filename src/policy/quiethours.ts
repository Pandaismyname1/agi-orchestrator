/**
 * Quiet hours — a notification schedule that silences alerts during a daily local
 * time window. An orchestrator that runs fleets unattended 24/7 must let the
 * operator say "don't page me overnight"; this is the pure, clock-injected core
 * that both the server (webhook delivery) and the client (sound alarm, via a
 * snapshot flag) consult.
 *
 * Deliberately simple, like the session scheduler: one daily window [start,end)
 * in local wall-clock time, optionally restricted to certain weekdays. A window
 * whose end is earlier than its start spans midnight (e.g. 22:00→07:00).
 */
import type { QuietHours, WebhookEvent } from "../types.js";
import { parseHHMM } from "./schedule.js";

const DAY_MIN = 24 * 60;

/**
 * Is `now` (epoch ms) inside the quiet window? Local wall clock — matches how a
 * person reads "10pm to 7am". Overnight windows are handled by also checking the
 * window that began *yesterday*. When `days` is set, it gates by the weekday the
 * window STARTED on (so "quiet Friday night" still silences early Saturday).
 *
 * A disabled config, a missing/malformed time, or a zero-length window (start ===
 * end) is never quiet — fail open so a misconfiguration can't silently mute you.
 */
export function inQuietHours(q: QuietHours | undefined, now: number): boolean {
  if (!q || q.enabled === false) return false;
  const s = parseHHMM(q.start);
  const e = parseHHMM(q.end);
  if (!s || !e) return false;
  const startMin = s.h * 60 + s.m;
  const endMin = e.h * 60 + e.m;
  if (startMin === endMin) return false; // degenerate — treat as no window
  const durMin = ((endMin - startMin) + DAY_MIN) % DAY_MIN; // overnight-aware length

  const base = new Date(now);
  // Check a window that started today and one that started yesterday (overnight).
  for (const back of [0, 1]) {
    const start = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate() - back,
      s.h,
      s.m,
      0,
      0,
    ).getTime();
    const end = start + durMin * 60_000;
    if (now >= start && now < end) {
      if (!q.days || q.days.length === 0) return true;
      if (q.days.includes(new Date(start).getDay())) return true;
    }
  }
  return false;
}

/**
 * Should a notification for `event` be suppressed right now? True only inside the
 * quiet window — and even then, `error` still gets through when `allowUrgent` is
 * set, so a broken run can page you regardless of the hour.
 */
export function suppresses(q: QuietHours | undefined, event: WebhookEvent, now: number): boolean {
  if (!inQuietHours(q, now)) return false;
  if (q?.allowUrgent && event === "error") return false;
  return true;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Short human description, e.g. `22:00–07:00 · Mon–Fri · errors still alert`. */
export function describeQuietHours(q: QuietHours | undefined): string {
  if (!q || q.enabled === false) return "off";
  if (!parseHHMM(q.start) || !parseHHMM(q.end)) return "misconfigured";
  const parts = [`${q.start}–${q.end}`];
  if (q.days && q.days.length > 0 && q.days.length < 7) {
    parts.push(
      [...q.days]
        .filter((d) => d >= 0 && d <= 6)
        .sort((a, b) => a - b)
        .map((d) => DOW[d])
        .join(", "),
    );
  } else {
    parts.push("every day");
  }
  if (q.allowUrgent) parts.push("errors still alert");
  return parts.join(" · ");
}
