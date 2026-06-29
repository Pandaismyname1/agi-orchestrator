/**
 * Guard rails. The real cost of this project isn't dollars (subscription is
 * flat) — it's burning your rate-limit / weekly cap and letting a loop run away.
 * These guards enforce hard stops so an unattended session can't spiral.
 */
import type { Limits } from "../types.js";

export interface GuardStop {
  stop: boolean;
  reason: string;
}

export class Guards {
  private readonly start = Date.now();
  private turns = 0;
  private recentPrompts: string[] = [];

  constructor(private readonly limits: Limits) {}

  /** Normalize a prompt for similarity comparison (whitespace/case/punctuation-insensitive). */
  private norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  /** Call BEFORE injecting the next prompt. Returns a stop directive if a limit is hit. */
  check(nextPrompt: string): GuardStop {
    this.turns += 1;

    if (this.turns > this.limits.maxTurns) {
      return { stop: true, reason: `hit maxTurns (${this.limits.maxTurns})` };
    }

    const elapsedMin = (Date.now() - this.start) / 60_000;
    if (elapsedMin > this.limits.maxWallClockMin) {
      return {
        stop: true,
        reason: `hit maxWallClockMin (${this.limits.maxWallClockMin}m, elapsed ${elapsedMin.toFixed(1)}m)`,
      };
    }

    // Ping-pong: N consecutive near-identical prompts means the loop is stuck.
    const n = this.norm(nextPrompt);
    this.recentPrompts.push(n);
    if (this.recentPrompts.length > this.limits.pingPongThreshold) {
      this.recentPrompts.shift();
    }
    if (
      this.recentPrompts.length >= this.limits.pingPongThreshold &&
      this.recentPrompts.every((p) => p === n)
    ) {
      return {
        stop: true,
        reason: `ping-pong detected: ${this.limits.pingPongThreshold} near-identical prompts in a row`,
      };
    }

    return { stop: false, reason: "" };
  }

  get turnCount(): number {
    return this.turns;
  }

  get elapsedMin(): number {
    return (Date.now() - this.start) / 60_000;
  }
}
