/**
 * Classify claude's TUI screen into a coarse state, from clean emulator text.
 *
 * These heuristics are tuned against Claude Code v2.1.x. They are deliberately
 * conservative: when unsure we return "unknown" and let the caller wait rather
 * than act. Observed markers (from live smoke tests):
 *   - WORKING: a status line with "(esc to interrupt)" while it thinks/acts.
 *   - GATE:    selection dialogs end with "Enter to confirm · Esc to cancel",
 *              and permission prompts ask "Do you want to proceed?" with a
 *              highlighted "❯ 1." option.
 *   - READY:   idle input box; bottom hint line shows "? for shortcuts" / "/effort".
 */
import type { ScreenState } from "../types.js";

const WORKING_RE = /\(esc to interrupt\)|esc to interrupt|tokens ·|↓\s*\d+\s*tokens/i;
const GATE_RE =
  /Enter to confirm|Do you want to proceed|Do you want to make this edit|❯\s*\d+\.\s|Yes, and don't ask again|No, and tell Claude/i;
const READY_RE = /\?\s*for shortcuts|\/effort|for agents/i;

export function classifyScreen(text: string): ScreenState {
  // Order matters: a gate can co-exist with the ready hint line, so check gate first.
  if (GATE_RE.test(text)) return "gate";
  if (WORKING_RE.test(text)) return "working";
  if (READY_RE.test(text)) return "ready";
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
