/**
 * Classify claude's TUI screen into a coarse state, from clean emulator text.
 *
 * "ready" means the session is genuinely done and can take the NEXT instruction —
 * the main prompt is idle AND nothing is in flight. A session that spawned
 * background agents sits at its idle input box WHILE those agents run; that is NOT
 * ready — prompting it ("merge now") just gets "can't, agents still running",
 * spinning forever. So WORKING (the main turn generating OR background agents
 * running) is checked BEFORE the idle box: the "esc to interrupt" / "↓ N tokens"
 * chrome is present exactly while work is in flight and gone once it's done.
 * Tuned against Claude Code v2.1.x. Conservative: unsure → "unknown".
 *   - GATE:    permission/selection dialog ("Enter to confirm · Esc to cancel",
 *              "Do you want to proceed?", highlighted "❯ 1.").
 *   - WORKING: work in flight — a spinner or background agents. Markers (TUI
 *              chrome, not assistant prose): "esc to interrupt", a "↓ N tokens"
 *              counter. WAIT; don't advance.
 *   - READY:   idle prompt with nothing running — its hint shows "? for shortcuts",
 *              "shift+tab to cycle", or "/effort", and NO in-flight chrome.
 */
import type { ScreenState } from "../types.js";

const GATE_RE =
  /Enter to confirm|Do you want to proceed|Do you want to make this edit|❯\s*\d+\.\s|Yes, and don't ask again|No, and tell Claude/i;
// Work in flight — the main turn OR background agents/tasks. These are TUI status
// chrome (an interrupt hint, a live token counter), present only while something
// is actually running and cleared once it finishes — so they distinguish "idle
// while agents churn" (WORKING) from "truly idle" (READY).
const WORKING_RE = /esc to interrupt|↓\s*[\d.,]+\s*tokens|[·•]\s*[\d.,]+k?\s*tokens/i;
// The idle input box, shown only at the main prompt.
const IDLE_RE = /\?\s*for shortcuts|shift\s*\+\s*tab to cycle|\/effort\b/i;

export function classifyScreen(text: string): ScreenState {
  // Order: a gate dialog overrides everything; then in-flight work (main OR
  // background agents) BEFORE the idle box, so we don't mistake "idle while agents
  // run" for "ready" and spin the brain against unfinished work.
  if (GATE_RE.test(text)) return "gate";
  if (WORKING_RE.test(text)) return "working";
  if (IDLE_RE.test(text)) return "ready";
  return "unknown";
}

/** Auth / fatal error surfaced in the TUI (e.g. 401). */
export function detectAuthError(text: string): boolean {
  return /API Error: 401|Invalid authentication credentials|Please run \/login/i.test(text);
}

/**
 * Detect the subscription usage-limit notice so the orchestrator can pause
 * instead of hammering a capped account. Deliberately matches only the
 * DISTINCTIVE system wordings — NOT a bare "rate limit", which would
 * false-positive when claude is merely writing code about rate limiting.
 */
export function detectRateLimit(text: string): boolean {
  return /usage limit reached|reached your usage limit|you'?ve reached your (usage|account|plan)? ?limit|approaching your usage limit|your (usage )?limit (will )?reset|limit resets? (at|in)\b|out of (usage|credits)\b|upgrade to increase your usage/i.test(
    text,
  );
}

/**
 * For a GATE screen, pick the index of the default/proceed option.
 * Claude highlights the recommended option with "❯" and numbers options 1..N.
 * The highlighted option is almost always the "proceed" choice, so we return
 * the highlighted number if found, else 1.
 */
export function defaultGateChoice(text: string): number {
  const m = text.match(/❯\s*(\d+)\./);
  if (m && m[1]) return Number(m[1]);
  return 1;
}
