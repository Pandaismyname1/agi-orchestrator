/**
 * Daily usage budget tracker.
 *
 * The orchestrator's real cost isn't dollars (the subscription is flat) — it's
 * the subscription's rate-limit / weekly cap. This caps total turns and
 * wall-clock minutes PER DAY across all sessions, so an unattended fleet can't
 * burn through the quota. Usage comes from the SQLite store (completed runs)
 * plus any live in-progress turns/minutes the supervisor passes in.
 */
import type { Store } from "../db/store.js";
import type { Budget } from "../types.js";

export interface BudgetStatus {
  turns: number;
  minutes: number;
  maxTurns?: number;
  maxMinutes?: number;
  exceeded: boolean;
  reason: string;
}

export class BudgetTracker {
  constructor(
    private readonly store: Store | undefined,
    private readonly budget: Budget | undefined,
  ) {}

  private startOfDayMs(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Today's usage = persisted (completed runs) + live (in-progress) figures. */
  status(live: { turns: number; minutes: number } = { turns: 0, minutes: 0 }): BudgetStatus {
    const persisted = this.store?.usageSince(this.startOfDayMs()) ?? { turns: 0, minutes: 0 };
    const turns = persisted.turns + live.turns;
    const minutes = persisted.minutes + live.minutes;

    let exceeded = false;
    let reason = "";
    if (this.budget?.maxTurnsPerDay != null && turns >= this.budget.maxTurnsPerDay) {
      exceeded = true;
      reason = `daily turn budget reached (${turns}/${this.budget.maxTurnsPerDay})`;
    } else if (this.budget?.maxMinutesPerDay != null && minutes >= this.budget.maxMinutesPerDay) {
      exceeded = true;
      reason = `daily time budget reached (${minutes.toFixed(0)}/${this.budget.maxMinutesPerDay}m)`;
    }

    return {
      turns,
      minutes,
      maxTurns: this.budget?.maxTurnsPerDay,
      maxMinutes: this.budget?.maxMinutesPerDay,
      exceeded,
      reason,
    };
  }
}
