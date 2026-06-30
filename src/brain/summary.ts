/**
 * Rolling project summary (smarter brain context, slice 2).
 *
 * Feeding the brain the raw last-N messages every turn drifts and bloats: old
 * detail crowds out the arc, and N messages of TUI noise is a lot of tokens. A
 * RollingSummary keeps a compact, maintained "where this project is" digest —
 * what's done / in progress / next / blocked — folded forward on a cadence by
 * ONE local-LLM call. The brain then sees {summary + a short fresh tail} instead
 * of a long raw transcript: less drift, cheaper, steadier on long runs.
 *
 * Local-only (reuses the brain's LocalLLM) and defensive: any summarizer failure
 * keeps the previous summary, so a decision is never blocked by it.
 */
import type { LocalLLM } from "./provider.js";

export interface RollingSummaryOptions {
  /** Off by default; when false the orchestrator never constructs one. */
  enabled?: boolean;
  /** Re-summarize at most once per this many turns (default 4). */
  everyTurns?: number;
  /** Hard cap on the summary length fed to the brain (default 1200). */
  maxChars?: number;
  /** How many raw messages to still pass alongside the summary (default 3). */
  tailMessages?: number;
}

type Msg = { role: "user" | "assistant"; text: string };

/** Max characters of rendered RECENT STEPS handed to the summarizer per fold. */
const FOLD_INPUT_BUDGET = 4000;

const SYSTEM_PROMPT =
  "You maintain a RUNNING SUMMARY of an autonomous coding session, for an operator who " +
  "decides what the agent does next. Given the PRIOR SUMMARY and the RECENT STEPS since it, " +
  "write an UPDATED summary capturing: what is DONE, what is IN PROGRESS, what is NEXT, and " +
  "any decisions made or blockers. Carry forward still-relevant facts from the prior summary; " +
  "drop what's now obsolete. Be factual and compact — no preamble, no fluff. Output ONLY the " +
  "summary text.";

/** Render role-tagged history, newest-last, dropping oldest lines past the budget. */
function renderTail(history: Msg[]): string {
  const lines = history.map((h) => `${h.role === "user" ? "[you]" : "[agent]"} ${h.text}`);
  let start = 0;
  const lenFrom = (from: number): number =>
    lines.slice(from).reduce((n, l, i) => n + l.length + (i > 0 ? 1 : 0), 0);
  while (start < lines.length && lenFrom(start) > FOLD_INPUT_BUDGET) start++;
  return lines.slice(start).join("\n");
}

export class RollingSummary {
  private summary = "";
  private lastUpdatedTurn = 0;
  private readonly everyTurns: number;
  private readonly maxChars: number;
  readonly tailMessages: number;

  constructor(opts?: RollingSummaryOptions) {
    this.everyTurns = Math.max(1, opts?.everyTurns ?? 4);
    this.maxChars = Math.max(200, opts?.maxChars ?? 1200);
    this.tailMessages = Math.max(0, opts?.tailMessages ?? 3);
  }

  /** The current summary text (may be "" before the first successful fold). */
  get text(): string {
    return this.summary;
  }

  /**
   * Fold recent history into the summary when the cadence is due (or on the very
   * first turn that has any history). One bounded local-LLM call; on any failure
   * the prior summary is kept and the cadence un-advanced so it retries next turn.
   */
  async maybeUpdate(llm: LocalLLM, turnNumber: number, history: Msg[]): Promise<void> {
    if (history.length === 0) return;
    if (this.summary && turnNumber - this.lastUpdatedTurn < this.everyTurns) return;

    const user =
      `PRIOR SUMMARY:\n${this.summary || "(none yet)"}\n\n` +
      `RECENT STEPS (oldest first):\n${renderTail(history)}`;
    try {
      const raw = await llm.chat([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ]);
      const next = (raw ?? "").trim();
      if (!next) return; // empty model output — keep the prior summary, retry later
      this.summary = next.length > this.maxChars ? next.slice(0, this.maxChars).trimEnd() : next;
      this.lastUpdatedTurn = turnNumber;
    } catch {
      // summarizer unreachable / errored — keep the prior summary, retry next turn
    }
  }
}
