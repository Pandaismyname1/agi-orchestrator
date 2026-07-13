/**
 * Qwen screen triage — the fallback perception layer.
 *
 * The fast path for reading Claude Code's TUI is the regex classifier in
 * terminal/state.ts, but regexes lose the arms race with every Claude Code
 * release (frozen-screen run deaths were exactly that). When the recovery
 * ladder in ClaudeSession finds a frozen, unrecognized screen, it hands the
 * rendered text to the LOCAL brain and asks: what is this screen, and is there
 * ONE safe key that unsticks it?
 *
 * Safety rail (decision D7): the model may only suggest Enter, Esc, or a single
 * digit — the session enforces this via triageKeyBytes and never types free
 * text from the triage path. Every triage is logged so recurring patterns can
 * be promoted into the fast regexes.
 */
import { LocalLLM } from "./provider.js";
import { extractJson } from "./decide.js";
import type { ScreenTriage } from "../session/claudeSession.js";

const TRIAGE_SYSTEM = `You are diagnosing a possibly-stuck terminal screen from Claude Code (an interactive TUI coding agent). You get the rendered screen text. Classify it:
- "ready": idle input box awaiting the next instruction; nothing running. (Footer hints like "? for shortcuts", mode chips like "bypass permissions on", or a completed line like "✻ Worked for 12m 5s". Background shells/servers may still be listed — that is still ready.)
- "working": generation or tool execution in progress (spinner with "esc to interrupt", live token counters).
- "gate": a permission dialog asking to approve/deny an action ("Do you want to proceed?", "Enter to confirm").
- "menu": a selection list asking the operator to pick an option ("Enter to select", arrow-key navigation).
- "survey": a feedback poll (e.g. "How is Claude doing this session?" with numbered ratings and "0: Dismiss").
- "error": a crash or fatal error banner.
- "unknown": none of the above.

Optionally suggest ONE key press, only when it clearly helps: "enter" to accept a highlighted default, "esc" to dismiss a modal/menu, or a single digit to pick a numbered option (e.g. "0" to dismiss a survey). Omit "key" when unsure — a wrong key is worse than none.

Respond with ONLY a JSON object, no prose, no code fence:
{"state":"ready|working|gate|menu|survey|error|unknown","key":"enter|esc|<digit>","reason":"<one short sentence>"}`;

const VALID_STATES = new Set(["ready", "working", "gate", "menu", "survey", "error", "unknown"]);

/**
 * Ask the local brain to classify a screen. Never throws — an unreachable model
 * or garbage output returns null and the caller falls through to the next rung.
 */
export async function triageScreen(llm: LocalLLM, screenText: string): Promise<ScreenTriage | null> {
  try {
    const raw = await llm.chat([
      { role: "system", content: TRIAGE_SYSTEM },
      { role: "user", content: `SCREEN:\n${screenText.slice(-4000)}\n\nClassify. JSON only.` },
    ]);
    const obj = extractJson(raw);
    if (!obj) return null;
    const state = typeof obj.state === "string" && VALID_STATES.has(obj.state) ? obj.state : "unknown";
    const key = typeof obj.key === "string" ? obj.key : undefined;
    const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 200) : undefined;
    return { state: state as ScreenTriage["state"], key, reason };
  } catch {
    return null;
  }
}
