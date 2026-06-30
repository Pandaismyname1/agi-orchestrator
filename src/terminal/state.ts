/**
 * Classify claude's TUI screen into a coarse state, from clean emulator text.
 *
 * We care about the MAIN session's state, NOT its background agents. A subagent
 * running in the background keeps printing "esc to interrupt" / "↓ N tokens"
 * status even while the main session sits idle at its input box — so we must
 * detect the idle box and let it WIN over that background "working" noise,
 * otherwise the session looks perpetually busy and the orchestrator never
 * advances. Tuned against Claude Code v2.1.x. Conservative: unsure → "unknown".
 *   - GATE:    permission/selection dialog ("Enter to confirm · Esc to cancel",
 *              "Do you want to proceed?", highlighted "❯ 1.").
 *   - READY:   the main idle input box — its hint line shows "? for shortcuts",
 *              "shift+tab to cycle" (mode toggle), or "/effort". These appear
 *              ONLY at the idle prompt, even when background agents are churning.
 *   - WORKING: the MAIN turn is generating — a spinner with "(esc to interrupt)"
 *              and NO idle hint line present.
 */
import type { ScreenState } from "../types.js";

// The idle input box. "shift+tab to cycle" / "? for shortcuts" / "/effort" are
// shown only at the main prompt; "esc to interrupt" in that hint line refers to
// background agents, so it is NOT a main-session "working" signal.
const IDLE_RE = /\?\s*for shortcuts|shift\s*\+\s*tab to cycle|for shortcuts|\/effort\b/i;
const GATE_RE =
  /Enter to confirm|Do you want to proceed|Do you want to make this edit|❯\s*\d+\.\s|Yes, and don't ask again|No, and tell Claude/i;
const WORKING_RE = /\(esc to interrupt\)|esc to interrupt|·\s*↓?\s*[\d.,]+\s*tokens|↓\s*[\d.,]+\s*tokens/i;

export function classifyScreen(text: string): ScreenState {
  // Order matters. Gate first (a dialog overrides everything). Then the idle box
  // BEFORE working: when the main session is idle, its hint line is present even
  // if a background agent is still emitting "working" status, and the main
  // session — the only one we drive — is what "ready" means.
  if (GATE_RE.test(text)) return "gate";
  if (IDLE_RE.test(text)) return "ready";
  if (WORKING_RE.test(text)) return "working";
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
