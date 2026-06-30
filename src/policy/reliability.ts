/**
 * Reliability tuning — pure helpers that turn the optional, possibly-garbage
 * `AppConfig.reliability` into clamped, usable values for the brain retry policy
 * and the auto-pause health-poll cadence. Centralized so the supervisor, the
 * orchestrator wiring, and the settings handler all agree on bounds + defaults.
 */
import type { ReliabilityOptions } from "../types.js";
import type { RetryOptions } from "../brain/provider.js";

export const RELIABILITY_DEFAULTS = {
  retries: 3,
  retryBackoffMs: 400,
  brainPollSeconds: 15,
} as const;

/** Inclusive clamp; non-finite input falls back to `def`. */
function clamp(v: unknown, lo: number, hi: number, def: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

/** Normalize raw config into safe, bounded reliability settings. */
export function normalizeReliability(r: ReliabilityOptions | undefined): Required<ReliabilityOptions> {
  return {
    // 0 retries is valid (disables retrying); cap so a blip can't loop forever.
    retries: clamp(r?.retries, 0, 10, RELIABILITY_DEFAULTS.retries),
    // Floor the backoff so we never busy-loop; cap so it stays responsive.
    retryBackoffMs: clamp(r?.retryBackoffMs, 50, 10_000, RELIABILITY_DEFAULTS.retryBackoffMs),
    // At least 5s between health polls (don't hammer the endpoint); at most 5m.
    brainPollSeconds: clamp(r?.brainPollSeconds, 5, 300, RELIABILITY_DEFAULTS.brainPollSeconds),
  };
}

/** Retry policy for `LocalLLM` from reliability config. */
export function retryOptsFrom(r: ReliabilityOptions | undefined): RetryOptions {
  const n = normalizeReliability(r);
  return { retries: n.retries, baseMs: n.retryBackoffMs };
}

/** Auto-pause health-poll interval, in milliseconds. */
export function brainPollMsFrom(r: ReliabilityOptions | undefined): number {
  return normalizeReliability(r).brainPollSeconds * 1000;
}
