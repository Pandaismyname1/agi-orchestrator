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
// Work in flight — the main turn OR background agents/tasks. Captured from real
// Claude Code v2.1 screens (markers cleared once work finishes):
//   - main turn generating:  "(esc to interrupt)" in the footer.
//   - blocked on agents:     "✻ Waiting for N background agent to finish" — and the
//     footer may be the IDLE footer (no "esc to interrupt"), so this line is the
//     decisive signal that the main is idle ONLY because agents are still running.
//   - live token counter:    "↑ 21.6k tokens" / "↓ 2.1k tokens" — note the arrow can
//     be UP or down and the count is abbreviated (k/m). (Anchored on "tokens" so the
//     "↓ to manage" footer hint does NOT trip it.)
// NOTE: "N shell(s) still running" is deliberately NOT working — background shells
// are typically dev servers that never exit; the main prompt is idle and the turn's
// final message is already in the transcript. Treating them as in-flight turned
// finished turns into 8-minute frozen-screen deaths (see docs/AUTOPILOT decision D1).
const WORKING_RE =
  /esc to interrupt|Waiting for \d+ background agent|[↑↓·•]\s*[\d.,]+\s*[km]?\s*tokens/i;
// The idle input box / idle footer, shown only at the main prompt. Footer hints
// rotate and vary by permission mode and background-task chips, so this matches
// every attested variant (v2.1.x):
//   "? for shortcuts", "shift+tab to cycle", "/effort"
//   mode chips: "bypass permissions on", "accept edits on", "plan mode on"
//   background-task chips: "1 shell", "← for agents", "↓ to manage"
const IDLE_RE =
  /\?\s*for shortcuts|shift\s*\+\s*tab to cycle|\/effort\b|bypass permissions on|accept edits on|plan mode on|\b\d+\s+shells?\b|←\s*for agents|↓\s*to manage/i;
// The completed-turn spinner line: "✻ Worked for 24m 28s", "✻ Sautéed for 18m 12s ·
// 1 shell still running". The duration unit is attached to the number ("24m", "28s"),
// which distinguishes it from the in-flight "✻ Waiting for 1 background agent".
const TURN_DONE_RE = /[✻·*]\s+\S+ for (?:\d+h\s*)?\d+[ms](?:\s+\d+s)?\b/;

export function classifyScreen(text: string): ScreenState {
  // Order: a gate dialog overrides everything; then in-flight work (main OR
  // background agents) BEFORE the idle box, so we don't mistake "idle while agents
  // run" for "ready" and spin the brain against unfinished work.
  if (GATE_RE.test(text)) return "gate";
  if (WORKING_RE.test(text)) return "working";
  if (IDLE_RE.test(text)) return "ready";
  // No footer hint matched, but a completed-turn spinner line ("✻ Worked for 24m
  // 28s") with no in-flight chrome means the turn is over and the prompt is idle.
  if (TURN_DONE_RE.test(text)) return "ready";
  return "unknown";
}

/**
 * Claude Code's occasional "How is Claude doing this session?" feedback survey.
 * It pops up mid-session and can swallow the next keystroke (a stray "1/2/3"),
 * so the driver dismisses it (Esc) before injecting.
 */
export function detectFeedbackSurvey(text: string): boolean {
  return /How is Claude doing this session\?|1:\s*Bad\s+2:\s*Fine\s+3:\s*Good/i.test(text);
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

/**
 * Detect Claude's `AskUserQuestion` interactive choice menu — the modal the model
 * pops up to ask the OPERATOR to pick from a list (single or multi-question, with
 * a "← [ ] Question  ∫ Submit →" carousel header). This is NOT a permission gate:
 * its footer reads "Enter to select · Tab/Arrow keys to navigate · Esc to cancel"
 * (a permission prompt says "Enter to confirm"). It also never renders the idle
 * input box, so it is neither "ready" nor "working" — left alone it would freeze
 * the turn until the stuck-timeout, which is the "agent stuck when Claude proposes
 * options" bug. The session detects it, Esc-dismisses it, and lets the brain answer
 * the question (surfaced from the transcript) in plain text on the next turn.
 *
 * Keyed on the distinctive footer wording so it never trips on a permission gate
 * ("Enter to confirm") or the idle box.
 */
export function detectChoicePrompt(text: string): boolean {
  return /Enter to select\b|Tab\s*\/\s*Arrow keys to navigate|(?:↑↓|arrow keys|Tab) to navigate/i.test(
    text,
  );
}
