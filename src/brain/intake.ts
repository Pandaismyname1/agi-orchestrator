/**
 * Goal intake assistant (AI tooling). Before a session runs unattended, a vague
 * goal is the #1 cause of mid-run escalations and wasted turns. This asks the
 * LOCAL brain to judge whether a goal + done-criteria are specific enough to hand
 * to an autonomous agent and, if not, to ask a few sharpening questions and
 * propose a tighter goal / done-criteria the operator can accept with one click.
 *
 * Local-only: it uses the same loopback provider as the decision brain — no paid
 * API, subscription-safe.
 */
import { LocalLLM, type ChatMessage } from "./provider.js";
import type { TemplateSuggestion, DependsOnSuggestion } from "../policy/suggest.js";

export interface IntakeInput {
  /** Project directory (gives the model a hint of context; optional). */
  cwd?: string;
  goal: string;
  doneCriteria: string;
}

export interface IntakeResult {
  /** "clear" = specific enough to run unattended; "vague" = should be sharpened. */
  clarity: "clear" | "vague";
  /** One-line, human-readable assessment. */
  assessment: string;
  /** Up to 3 sharpening questions (empty when clear). */
  questions: string[];
  /** A tighter goal the operator can accept (omitted when there's nothing to add). */
  suggestedGoal?: string;
  /** A tighter done-criteria the operator can accept. */
  suggestedDoneCriteria?: string;
  /** Templates from the project's history that fit this goal (deterministic). */
  suggestedTemplates?: TemplateSuggestion[];
  /** Existing same-project sessions this one likely runs after (deterministic). */
  suggestedDependsOn?: DependsOnSuggestion[];
}

const SYSTEM = `You set up autonomous coding agents (Claude Code) that run UNATTENDED toward a goal with no human watching.
A vague goal or fuzzy done-criteria is the top cause of wasted work and mid-run interruptions.

Given a proposed GOAL and DONE-CRITERIA, judge whether they are specific enough to hand to an agent that will work for hours alone.
- "clear": concrete deliverable, unambiguous scope, and a done-criteria you could objectively check. No questions needed.
- "vague": missing scope, ambiguous wording, or a done-criteria that can't be verified — needs sharpening.

If vague, ask up to 3 SHORT sharpening questions (the things you'd need to know to scope it) and propose a tighter goal + done-criteria that fold in reasonable defaults. Keep suggestions faithful to the user's intent — sharpen, don't invent new scope.

Respond with ONLY a JSON object, no prose, no code fence:
{
  "clarity": "clear" | "vague",
  "assessment": "one sentence on what's good or what's missing",
  "questions": ["short question", "..."],
  "suggestedGoal": "a sharper goal, or empty string if nothing to improve",
  "suggestedDoneCriteria": "a sharper, checkable done-criteria, or empty string"
}`;

/** Build the chat messages for an intake assessment. */
export function buildIntakePrompt(input: IntakeInput): ChatMessage[] {
  const ctx = input.cwd?.trim() ? `PROJECT DIRECTORY: ${input.cwd.trim()}\n` : "";
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `${ctx}GOAL:\n${input.goal.trim()}\n\nDONE-CRITERIA:\n${input.doneCriteria.trim()}`,
    },
  ];
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

function cleanStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Parse a model response into an IntakeResult. Fails OPEN: if the model returns
 * nothing parseable, treat the goal as clear (never block session creation on a
 * flaky intake call).
 */
export function parseIntake(raw: string): IntakeResult {
  const obj = extractJson(raw);
  if (!obj) {
    return { clarity: "clear", assessment: "Couldn't assess the goal — proceeding as-is.", questions: [] };
  }
  const questions = Array.isArray(obj.questions)
    ? obj.questions.map((q) => cleanStr(q)).filter((q): q is string => !!q).slice(0, 3)
    : [];
  // Only call it "vague" when the model said so AND actually gave something to act on.
  const saidVague = obj.clarity === "vague";
  const suggestedGoal = cleanStr(obj.suggestedGoal);
  const suggestedDoneCriteria = cleanStr(obj.suggestedDoneCriteria);
  const hasHelp = questions.length > 0 || !!suggestedGoal || !!suggestedDoneCriteria;
  const clarity: IntakeResult["clarity"] = saidVague && hasHelp ? "vague" : "clear";
  return {
    clarity,
    assessment: cleanStr(obj.assessment) ?? (clarity === "clear" ? "Looks specific enough to run." : "Could be sharper."),
    questions: clarity === "vague" ? questions : [],
    suggestedGoal: clarity === "vague" ? suggestedGoal : undefined,
    suggestedDoneCriteria: clarity === "vague" ? suggestedDoneCriteria : undefined,
  };
}

/** Assess a goal/done-criteria for clarity via the local brain. One LLM call. */
export async function assessGoal(llm: LocalLLM, input: IntakeInput): Promise<IntakeResult> {
  const raw = await llm.chat(buildIntakePrompt(input));
  return parseIntake(raw);
}
