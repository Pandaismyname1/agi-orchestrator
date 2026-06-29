/**
 * The brain's job: read a finished claude turn and decide, as the user's
 * stand-in, what to do next — produce the next instruction, or STOP.
 *
 * This is the part that replaces YOU sitting there answering "yes, continue".
 * The model is told to stay anchored to the ORIGINAL goal (so it doesn't let
 * claude wander), to keep instructions short and concrete, and to emit STOP the
 * moment the done-criteria are met or claude is blocked on something only a
 * human can resolve.
 */
import type { AttentionOption, Decision, SessionConfig } from "../types.js";
import { LocalLLM, type ChatMessage } from "./provider.js";

/** Autonomy-specific guidance that tunes how readily the operator escalates. */
const AUTONOMY_DIRECTIVE: Record<NonNullable<SessionConfig["autonomy"]>, string> = {
  cautious:
    "AUTONOMY: CAUTIOUS. Escalate generously — when in any doubt, hand the decision to the human rather than choosing yourself. Prefer escalate over continue for anything that isn't trivially routine.",
  balanced:
    "AUTONOMY: BALANCED. Escalate only genuine judgement calls; handle routine progress yourself.",
  autonomous:
    "AUTONOMY: AUTONOMOUS. Keep moving on your own; only escalate for truly irreversible/destructive actions, missing credentials/info only the user has, or work clearly outside the goal. Make ordinary product/technical choices yourself and continue.",
};

/** Build the operator system prompt, tuned by the session's autonomy level. */
export function buildSystemPrompt(autonomy?: SessionConfig["autonomy"]): string {
  const directive = AUTONOMY_DIRECTIVE[autonomy ?? "balanced"];
  return `You are the OPERATOR of an autonomous coding agent (Claude Code). You speak to it AS the human user would.
The agent just finished a turn. You read its last message and choose ONE action: continue, stop, or escalate.

Pick "continue" for routine progress: answer a simple "shall I continue?" or give the obvious next step that moves toward the goal. Keep the instruction short, concrete, one step.

Pick "stop" when the done-criteria are satisfied, or the agent is going in circles / asking to confirm already-finished work.

Pick "escalate" — hand the decision to the human — when a GENUINE judgement call is needed that you should NOT make on their behalf:
  * an irreversible or destructive action (deleting data, force-push, sending things externally, spending money),
  * ambiguous requirements where reasonable people would choose differently,
  * a choice with real taste / product / business tradeoffs (which library, which design direction, which scope cut),
  * something needing credentials, secrets, or information only the user has,
  * anything clearly OUTSIDE the stated goal/scope.
When you escalate, give a one-line "question" naming the decision, and 2-4 "options". Each option has a short "label", a one-line "rationale" (the tradeoff), and a "prompt" — the EXACT instruction to send the agent if the user picks it.

${directive}

Hard rules:
- Stay anchored to the ORIGINAL GOAL. Do not invent scope or gold-plate.
- Never instruct a destructive/irreversible action yourself — escalate it.

Respond with ONLY a JSON object, no prose, no code fence:
{"action":"continue"|"stop"|"escalate","prompt":"<next instruction if continue>","reason":"<one short sentence>","question":"<the decision, if escalate>","options":[{"label":"...","rationale":"...","prompt":"..."}]}`;
}

/** Max total characters of rendered RECENT STEPS history to include. */
const HISTORY_CHAR_BUDGET = 4000;

/**
 * Render recent history as a compact "RECENT STEPS" block, newest-last.
 * Each entry is `[you] <text>` (user) or `[agent] <text>` (assistant).
 * Caps total rendered size to ~HISTORY_CHAR_BUDGET chars by dropping the
 * OLDEST entries first. Returns "" if there's nothing to render.
 */
function renderHistory(
  history: Array<{ role: "user" | "assistant"; text: string }>,
): string {
  const rendered = history.map(
    (h) => `${h.role === "user" ? "[you]" : "[agent]"} ${h.text}`,
  );
  // Drop oldest entries until the joined block fits the budget.
  let start = 0;
  const joinedLen = (from: number): number => {
    let len = 0;
    for (let i = from; i < rendered.length; i++) {
      len += rendered[i]!.length;
      if (i > from) len += 1; // newline separator
    }
    return len;
  };
  while (start < rendered.length && joinedLen(start) > HISTORY_CHAR_BUDGET) {
    start++;
  }
  return rendered.slice(start).join("\n");
}

function buildUserMessage(
  session: SessionConfig,
  lastAssistantText: string,
  turnNumber: number,
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): string {
  const parts: string[] = [
    `ORIGINAL GOAL:\n${session.goal}`,
    `DONE WHEN:\n${session.doneCriteria}`,
    `TURN NUMBER: ${turnNumber}`,
  ];
  if (history && history.length > 0) {
    const block = renderHistory(history);
    if (block) parts.push(`RECENT STEPS (oldest first):\n${block}`);
  }
  parts.push(
    `AGENT'S LAST MESSAGE:\n${lastAssistantText || "(no text — the agent produced no message)"}`,
    `Decide the next instruction or STOP. JSON only.`,
  );
  return parts.join("\n\n");
}

/** Pull the first JSON object out of a model response, tolerating fences/prose. */
function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function decideNextStep(
  llm: LocalLLM,
  session: SessionConfig,
  lastAssistantText: string,
  turnNumber: number,
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<Decision> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(session.autonomy) },
    { role: "user", content: buildUserMessage(session, lastAssistantText, turnNumber, history) },
  ];
  const raw = await llm.chat(messages);
  const obj = extractJson(raw);

  if (!obj || (obj.action !== "continue" && obj.action !== "stop" && obj.action !== "escalate")) {
    // Fail safe: if the brain gives garbage, stop rather than inject nonsense.
    return {
      action: "stop",
      reason: `brain returned unparseable decision; stopping for safety. raw="${raw.slice(0, 120)}"`,
    };
  }
  if (obj.action === "stop") {
    return { action: "stop", reason: String(obj.reason ?? "brain decided to stop") };
  }
  if (obj.action === "escalate") {
    const options = parseOptions(obj.options);
    // An escalation with no usable options can't be presented — fail safe to stop.
    if (options.length === 0) {
      return {
        action: "stop",
        reason: `brain wanted a human decision but gave no options; stopping for safety. (${String(obj.question ?? "")})`,
      };
    }
    return {
      action: "escalate",
      reason: String(obj.reason ?? "needs a human decision"),
      question: String(obj.question ?? obj.reason ?? "A decision is needed."),
      options,
    };
  }
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  if (!prompt) {
    return { action: "stop", reason: "brain said continue but gave no prompt; stopping for safety." };
  }
  return { action: "continue", prompt, reason: String(obj.reason ?? "continuing") };
}

/** Validate/clean the options array from an escalate decision. */
function parseOptions(raw: unknown): AttentionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AttentionOption[] = [];
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label.trim() : "";
    const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
    if (!label || !prompt) continue; // an option must be selectable and actionable
    out.push({
      label,
      prompt,
      rationale: typeof r.rationale === "string" ? r.rationale.trim() : "",
    });
    if (out.length >= 4) break;
  }
  return out;
}
