/**
 * Per-IP sliding-window rate limiting for remote (dispatch) traffic.
 *
 * Two independent limiters keyed by client IP:
 *  - general:  caps total requests/window (anti-hammer).
 *  - authFail: caps AUTH FAILURES/window (brute-force guard on the token) — much
 *              stricter and with a longer window.
 *
 * Local (loopback) traffic is never limited; the caller decides that. Purely
 * in-memory (single-process dashboard); entries self-expire so it can't grow
 * unbounded. `now` is injectable so tests don't depend on the wall clock.
 */
import type { RateLimitOptions } from "../types.js";

export interface RateLimitConfig {
  windowMs: number;
  maxRequestsPerWindow: number;
  authWindowMs: number;
  maxAuthFailures: number;
}

export function resolveRateLimitConfig(opts: RateLimitOptions | undefined): RateLimitConfig {
  return {
    windowMs: opts?.windowMs ?? 60_000,
    maxRequestsPerWindow: opts?.maxRequestsPerWindow ?? 300,
    authWindowMs: opts?.authWindowMs ?? 300_000,
    maxAuthFailures: opts?.maxAuthFailures ?? 12,
  };
}

interface Bucket {
  /** Timestamps (ms) of recent hits, oldest first. */
  hits: number[];
}

export interface LimitVerdict {
  ok: boolean;
  /** Seconds until the caller may retry (when blocked). */
  retryAfterSec?: number;
}

export class RateLimiter {
  #cfg: RateLimitConfig;
  #now: () => number;
  #general = new Map<string, Bucket>();
  #authFail = new Map<string, Bucket>();
  #lastSweep = 0;

  constructor(cfg: RateLimitConfig, now: () => number = () => Date.now()) {
    this.#cfg = cfg;
    this.#now = now;
  }

  /** Record a general request and report whether it's within budget. */
  hit(ip: string): LimitVerdict {
    return this.#roll(this.#general, ip, this.#cfg.windowMs, this.#cfg.maxRequestsPerWindow, true);
  }

  /** Is this IP currently blocked by the auth-failure guard? (read-only) */
  authBlocked(ip: string): LimitVerdict {
    return this.#roll(this.#authFail, ip, this.#cfg.authWindowMs, this.#cfg.maxAuthFailures, false);
  }

  /** Record one auth failure for this IP. */
  recordAuthFailure(ip: string): void {
    const b = this.#bucket(this.#authFail, ip);
    b.hits.push(this.#now());
  }

  /** Clear an IP's auth-failure record after a successful auth. */
  clearAuthFailures(ip: string): void {
    this.#authFail.delete(ip);
  }

  #bucket(map: Map<string, Bucket>, ip: string): Bucket {
    let b = map.get(ip);
    if (!b) {
      b = { hits: [] };
      map.set(ip, b);
    }
    return b;
  }

  /**
   * Slide the window, optionally append the current hit, and verdict against max.
   * When `append` is false this is a read-only check (no new hit recorded).
   */
  #roll(
    map: Map<string, Bucket>,
    ip: string,
    windowMs: number,
    max: number,
    append: boolean,
  ): LimitVerdict {
    const now = this.#now();
    this.#maybeSweep(now);
    const b = this.#bucket(map, ip);
    const cutoff = now - windowMs;
    // Drop expired hits (oldest first).
    let i = 0;
    while (i < b.hits.length && (b.hits[i] ?? Infinity) <= cutoff) i++;
    if (i > 0) b.hits.splice(0, i);

    if (b.hits.length >= max) {
      const oldest = b.hits[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    if (append) b.hits.push(now);
    return { ok: true };
  }

  /** Periodically drop empty/stale buckets so the maps don't grow forever. */
  #maybeSweep(now: number): void {
    if (now - this.#lastSweep < 60_000) return;
    this.#lastSweep = now;
    const horizon = Math.max(this.#cfg.windowMs, this.#cfg.authWindowMs);
    for (const map of [this.#general, this.#authFail]) {
      for (const [ip, b] of map) {
        if (b.hits.length === 0 || (b.hits[b.hits.length - 1] ?? 0) <= now - horizon) map.delete(ip);
      }
    }
  }
}
