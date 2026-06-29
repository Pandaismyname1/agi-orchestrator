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
import type { Decision, SessionConfig } from "../types.js";
import { LocalLLM, type ChatMessage } from "./provider.js";

const SYSTEM = `You are the OPERATOR of an autonomous coding agent (Claude Code). You speak to it AS the human user would.
The agent just finished a turn. You read its last message and reply with the SINGLE next instruction, or stop.

Hard rules:
- Stay anchored to the ORIGINAL GOAL. Do not invent new scope. Do not gold-plate.
- Keep the instruction short, concrete, and actionable — one step, like a focused human would type.
- If the agent asked a question, ANSWER it in a way that moves toward the goal.
- Output STOP when ANY of these is true:
  * the done-criteria are satisfied,
  * the agent is blocked on something only a human can do (credentials, a decision you cannot infer, a destructive action),
  * the agent is going in circles or asking for confirmation of already-finished work.
- Never instruct destructive or irreversible actions (force-push, deleting data, sending things externally) without the human — STOP instead.

Respond with ONLY a JSON object, no prose, no code fence:
{"action":"continue"|"stop","prompt":"<next instruction if continue>","reason":"<one short sentence>"}`;

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
    { role: "system", content: SYSTEM },
    { role: "user", content: buildUserMessage(session, lastAssistantText, turnNumber, history) },
  ];
  const raw = await llm.chat(messages);
  const obj = extractJson(raw);

  if (!obj || (obj.action !== "continue" && obj.action !== "stop")) {
    // Fail safe: if the brain gives garbage, stop rather than inject nonsense.
    return {
      action: "stop",
      reason: `brain returned unparseable decision; stopping for safety. raw="${raw.slice(0, 120)}"`,
    };
  }
  if (obj.action === "stop") {
    return { action: "stop", reason: String(obj.reason ?? "brain decided to stop") };
  }
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  if (!prompt) {
    return { action: "stop", reason: "brain said continue but gave no prompt; stopping for safety." };
  }
  return { action: "continue", prompt, reason: String(obj.reason ?? "continuing") };
}
