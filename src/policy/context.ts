/**
 * Context-window manager. Long autopilot runs fill claude's context; rather than
 * let it hit a blunt auto-compact (which loses nuance), we proactively run a
 * **memory-preserving compaction** before the window fills:
 *   1. save a handoff file (goal progress, decisions, file map, next steps)
 *   2. `/compact` the conversation
 *   3. resume from the handoff file
 *
 * Trigger: we estimate context use from the transcript file SIZE (bytes/4 ≈
 * tokens) — reliable and provider-agnostic. If claude's own on-screen context
 * gauge is detectable we trust that instead (best-effort; a non-match simply
 * falls back to the estimate, so it's never harmful).
 */
import { stat } from "node:fs/promises";
import { transcriptPath } from "../transcript/reader.js";
import type { ContextGuardOptions } from "../types.js";

export type { ContextGuardOptions };

export const DEFAULT_CONTEXT_GUARD: Required<ContextGuardOptions> = {
  enabled: false,
  window: 200_000,
  compactAtPercent: 50,
  handoffFile: ".agi/handoff.md",
  minTurnsBetween: 6,
};

/** Rough token estimate from a byte count (English text ≈ 4 bytes/token). */
export const TOKENS_PER_BYTE = 1 / 4;

/**
 * Best-effort read of claude's own context gauge from the screen. Returns the
 * USED fraction (0..1) only on a confident match, else null (→ use the estimate).
 * NOTE: claude's exact wording varies by version — validate live and extend.
 */
export function parseScreenContextFraction(screen: string): number | null {
  if (!screen) return null;
  // "73% context used" / "context: 73% used"
  const used = screen.match(/(\d{1,3})%\s*(?:context\s*)?used/i) ?? screen.match(/context[^%]{0,20}?(\d{1,3})%\s*used/i);
  if (used) {
    const p = Number(used[1]);
    if (p >= 0 && p <= 100) return p / 100;
  }
  return null;
}

export class ContextGuard {
  readonly cfg: Required<ContextGuardOptions>;
  private lastCompactTurn = Number.NEGATIVE_INFINITY;

  constructor(opts?: ContextGuardOptions) {
    this.cfg = { ...DEFAULT_CONTEXT_GUARD, ...(opts ?? {}) };
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** Estimated fraction (0..1) of the context window currently in use. */
  async usedFraction(cwd: string, sessionId: string, screen?: string): Promise<number> {
    const fromScreen = screen ? parseScreenContextFraction(screen) : null;
    if (fromScreen !== null) return fromScreen;
    let bytes = 0;
    try {
      bytes = (await stat(transcriptPath(cwd, sessionId))).size;
    } catch {
      return 0; // no transcript yet → empty context
    }
    const tokens = bytes * TOKENS_PER_BYTE;
    return Math.min(1, tokens / this.cfg.window);
  }

  /** Should we compact now, given current use and the turn counter? */
  shouldCompact(usedFraction: number, turnCount: number): boolean {
    if (!this.cfg.enabled) return false;
    if (turnCount - this.lastCompactTurn < this.cfg.minTurnsBetween) return false;
    return usedFraction >= this.cfg.compactAtPercent / 100;
  }

  /** Record that we compacted on this turn (gates the next compaction). */
  markCompacted(turnCount: number): void {
    this.lastCompactTurn = turnCount;
  }

  /** The prompt that asks claude to write its handoff before compaction. */
  savePrompt(): string {
    return (
      `We're about to compact this conversation to free up context. First, write a concise but ` +
      `COMPLETE handoff to \`${this.cfg.handoffFile}\` (create the folder if needed; overwrite if it ` +
      `exists). Include: the goal and how far we've gotten; key decisions made and why; the important ` +
      `files/paths and their current state; anything still broken or in progress; and the precise next ` +
      `steps. This is the only memory that survives the compaction, so be thorough. Reply with just ` +
      `"handoff saved" when done.`
    );
  }

  /** The prompt that resumes work after compaction, from the handoff file. */
  resumePrompt(): string {
    return (
      `The conversation was just compacted to free context. Read \`${this.cfg.handoffFile}\` and ` +
      `continue working toward the goal from exactly where we left off.`
    );
  }
}
