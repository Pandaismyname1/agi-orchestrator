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

/**
 * Build the operator system prompt, tuned by the session's autonomy level and,
 * optionally, the owner's LEARNED operator profile (A3). Learned guidance is
 * inserted BEFORE the Hard rules so the safety rules always win; with no
 * guidance the output is byte-identical to baseline.
 */
export function buildSystemPrompt(
  autonomy?: SessionConfig["autonomy"],
  learnedGuidance?: string,
): string {
  const directive = AUTONOMY_DIRECTIVE[autonomy ?? "balanced"];
  const learned = learnedGuidance?.trim()
    ? `\n\nLEARNED OPERATOR PREFERENCES (from this user's own past steering — follow these unless they conflict with the Hard rules):\n${learnedGuidance.trim()}`
    : "";
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

${directive}${learned}

Hard rules:
- Stay anchored to the ORIGINAL GOAL. Do not invent scope or gold-plate.
- Never instruct a destructive/irreversible action yourself — escalate it.

Also report "confidence": a number 0..1 for how sure you are this is the right call (1 = certain; lower it when the agent's state is ambiguous, you're guessing the next step, or you can't tell real progress from the REPO STATE). Be honest — a low score routes the decision to the human instead of guessing.

Respond with ONLY a JSON object, no prose, no code fence:
{"action":"continue"|"stop"|"escalate","prompt":"<next instruction if continue>","reason":"<one short sentence>","confidence":<0..1>,"question":"<the decision, if escalate>","options":[{"label":"...","rationale":"...","prompt":"..."}]}`;
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
  repoState?: string,
  projectSummary?: string,
): string {
  const parts: string[] = [
    `ORIGINAL GOAL:\n${session.goal}`,
    `DONE WHEN:\n${session.doneCriteria}`,
    `TURN NUMBER: ${turnNumber}`,
  ];
  if (projectSummary && projectSummary.trim()) {
    parts.push(`PROJECT SO FAR (maintained running summary):\n${projectSummary.trim()}`);
  }
  if (history && history.length > 0) {
    const block = renderHistory(history);
    if (block) parts.push(`RECENT STEPS (oldest first):\n${block}`);
  }
  if (repoState && repoState.trim()) {
    parts.push(
      `REPO STATE (git ground truth — what ACTUALLY changed on disk; trust this over the agent's claims):\n${repoState.trim()}`,
    );
  }
  parts.push(
    `AGENT'S LAST MESSAGE:\n${lastAssistantText || "(no text — the agent produced no message)"}`,
    `Decide the next instruction or STOP. JSON only.`,
  );
  return parts.join("\n\n");
}

/** Pull the first JSON object out of a model response, tolerating fences/prose. */
export function extractJson(raw: string): Record<string, unknown> | null {
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
  learnedGuidance?: string,
  repoState?: string,
  confidenceThreshold?: number,
  projectSummary?: string,
): Promise<Decision> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(session.autonomy, learnedGuidance) },
    { role: "user", content: buildUserMessage(session, lastAssistantText, turnNumber, history, repoState, projectSummary) },
  ];
  let raw = await llm.chat(messages);
  let obj = extractJson(raw);
  const badShape = (o: Record<string, unknown> | null): boolean =>
    !o || (o.action !== "continue" && o.action !== "stop" && o.action !== "escalate");

  if (badShape(obj)) {
    // Self-repair: small local models occasionally wrap the JSON in prose or
    // drift from the schema. One corrective retry — quote the failure back and
    // demand bare JSON — before the fail-safe stop kills the run.
    raw = await llm.chat([
      ...messages,
      { role: "assistant", content: raw.slice(0, 2000) },
      {
        role: "user",
        content:
          'Your reply was not the required JSON (missing or invalid "action"). Respond again with ONLY the JSON object — no prose, no code fence: {"action":"continue"|"stop"|"escalate",...}',
      },
    ]);
    obj = extractJson(raw);
  }

  if (badShape(obj) || !obj) {
    // Fail safe: if the brain gives garbage twice, stop rather than inject nonsense.
    return {
      action: "stop",
      reason: `brain returned unparseable decision; stopping for safety. raw="${raw.slice(0, 120)}"`,
    };
  }
  const confidence = parseConfidence(obj.confidence);
  if (obj.action === "stop") {
    return { action: "stop", reason: String(obj.reason ?? "brain decided to stop"), confidence };
  }
  if (obj.action === "escalate") {
    const options = parseOptions(obj.options);
    // An escalation with no usable options can't be presented — fail safe to stop.
    if (options.length === 0) {
      return {
        action: "stop",
        reason: `brain wanted a human decision but gave no options; stopping for safety. (${String(obj.question ?? "")})`,
        confidence,
      };
    }
    return {
      action: "escalate",
      reason: String(obj.reason ?? "needs a human decision"),
      question: String(obj.question ?? obj.reason ?? "A decision is needed."),
      options,
      confidence,
    };
  }
  const prompt = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
  if (!prompt) {
    return { action: "stop", reason: "brain said continue but gave no prompt; stopping for safety.", confidence };
  }
  const decision: Decision = { action: "continue", prompt, reason: String(obj.reason ?? "continuing"), confidence };
  return gateLowConfidence(decision, confidenceThreshold);
}

/** Coerce a model-reported confidence to 0..1, tolerating a 0..100 percent. Undefined if unusable. */
function parseConfidence(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = v > 1 && v <= 100 ? v / 100 : v;
  if (n < 0 || n > 1) return undefined;
  return n;
}

/**
 * Auto-escalate a low-confidence `continue` to the human instead of guessing.
 * No-op unless threshold > 0 AND the decision is a `continue` whose reported
 * confidence is below it. `stop`/`escalate` already involve the human, and a
 * decision with no reported confidence is never gated (so models that ignore
 * the field behave exactly as before).
 */
export function gateLowConfidence(decision: Decision, threshold?: number): Decision {
  if (!threshold || threshold <= 0) return decision;
  if (decision.action !== "continue") return decision;
  if (typeof decision.confidence !== "number" || decision.confidence >= threshold) return decision;
  const pct = Math.round(decision.confidence * 100);
  return {
    action: "escalate",
    reason: `auto-escalated: operator confidence ${pct}% < ${Math.round(threshold * 100)}% threshold`,
    question: `The operator is only ${pct}% sure of the next step — your call.`,
    confidence: decision.confidence,
    options: [
      {
        label: "Proceed as proposed",
        rationale: decision.reason,
        prompt: decision.prompt ?? "Continue toward the goal.",
      },
      {
        label: "Redirect it",
        rationale: "the operator wasn't sure — re-anchor to the goal",
        prompt:
          "Re-read the original goal and the current repo state, state in one line what is actually needed next, then do exactly that.",
      },
    ],
  };
}

const ESCALATION_SYSTEM =
  "You are the SENIOR operator for an autonomous coding agent. A first-pass operator " +
  "already decided this turn needs a HUMAN decision. Your job is to produce the SHARPEST " +
  "version of that escalation: a one-line QUESTION naming the decision, and 2-4 strong, " +
  "genuinely-distinct OPTIONS. Each option has a short \"label\", a one-line \"rationale\" " +
  "(the REAL tradeoff), and a \"prompt\" — the EXACT instruction to send the agent if the " +
  "human picks it. Ground every option in the ORIGINAL GOAL, what ACTUALLY changed on disk " +
  "(REPO STATE), and the agent's state. Do not invent scope. Output ONLY a JSON object, no " +
  "prose: {\"question\":\"...\",\"options\":[{\"label\":\"...\",\"rationale\":\"...\",\"prompt\":\"...\"}]}";

/**
 * Second-pass escalation refinement (multi-model brain). When the fast brain
 * escalates, a bigger LOCAL model regenerates a sharper question + options. Pure
 * upgrade: any failure (model unreachable, garbage, no usable options) falls back
 * to the fast model's original escalation, so this never makes a decision worse.
 */
export async function refineEscalation(
  heavy: LocalLLM,
  session: SessionConfig,
  lastAssistantText: string,
  turnNumber: number,
  history: Array<{ role: "user" | "assistant"; text: string }> | undefined,
  repoState: string | undefined,
  draft: Decision,
): Promise<Decision> {
  if (draft.action !== "escalate") return draft;
  try {
    const user =
      buildUserMessage(session, lastAssistantText, turnNumber, history, repoState) +
      `\n\nThe first-pass operator escalated because: ${draft.reason}\n` +
      `Its draft question was: ${draft.question ?? "(none)"}\n` +
      `Produce the sharpest question + options. JSON only.`;
    const raw = await heavy.chat([
      { role: "system", content: ESCALATION_SYSTEM },
      { role: "user", content: user },
    ]);
    const obj = extractJson(raw);
    if (!obj) return draft;
    const options = parseOptions(obj.options);
    if (options.length === 0) return draft; // keep the fast model's escalation
    return {
      action: "escalate",
      reason: draft.reason,
      question: String(obj.question ?? draft.question ?? "A decision is needed."),
      options,
    };
  } catch {
    return draft;
  }
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
