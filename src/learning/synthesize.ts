/**
 * Synthesis (A3) — turn mined/derived examples into a DRAFT operator profile via
 * ONE bounded local-LLM call. The LLM reads REAL examples of how the owner steered
 * the agent and writes short imperative GUIDANCE bullets capturing the owner's
 * operating STYLE (tone, when to continue/escalate/stop, scope discipline, naming,
 * verbosity) — never task specifics, never generic safety rules.
 *
 * Local-only: the only network call is `llm.chat`, which targets the local LM
 * Studio / Ollama endpoint (see brain/provider.ts). No cloud API.
 *
 * Output is a DraftProposal — proposed only. Nothing here activates a profile;
 * approval lives elsewhere (see types.ts safety posture: propose → approve → revert).
 */
import type { LocalLLM } from "../brain/provider.js";
import type { DraftProposal, ExampleBankItem } from "./types.js";
import { truncate } from "./util.js";

const DEFAULT_MAX_EXAMPLES = 30;
const DEFAULT_MAX_FEWSHOT = 6;
const DEFAULT_GUIDANCE_BUDGET = 800;

/** Per-field clamp when rendering an example for the LLM (defensive). */
const SITUATION_CHARS = 400;
const INSTRUCTION_CHARS = 400;

const SYSTEM_PROMPT =
  "You tune the SYSTEM PROMPT of an autonomous coding-agent OPERATOR — a stand-in " +
  "who tells the agent what to do next. Given REAL examples of how THIS user steered " +
  "the agent, write 4-8 short imperative GUIDANCE bullets that capture the user's " +
  "operating STYLE and PREFERENCES: tone/wording, when to continue vs. escalate vs. " +
  "stop, scope discipline, naming/format conventions, verbosity. Capture preferences, " +
  "NOT task specifics. Do NOT restate generic safety rules. Output ONLY the bullet " +
  "lines (each starting with '- '), ≤120 words total, no preamble, no headers.";

const NO_SIGNAL_GUIDANCE =
  "Not enough signal yet — keep using sessions to build a profile.";
const NO_PATTERN_GUIDANCE =
  "- No strong patterns found yet — keep using sessions to build a profile.";

interface SynthesizeOpts {
  /** Provider model id, recorded in meta. */
  model: string;
  /** Ranked examples fed to the LLM (default 30). */
  maxExamples?: number;
  /** Few-shot examples kept in the profile (default 6). */
  maxFewShot?: number;
  /** Clamp guidance to this many chars (default 800). */
  guidanceCharBudget?: number;
  baseVersion?: number | null;
  /** Count of source === "past"; derived from examples when omitted. */
  pastCount?: number;
  /** Count of source === "live"; derived from examples when omitted. */
  liveCount?: number;
}

/** Rank by count desc, then lastSeen desc. Pure; does not mutate input. */
function rank(examples: ExampleBankItem[]): ExampleBankItem[] {
  return [...examples].sort(
    (a, b) => b.count - a.count || b.lastSeen - a.lastSeen,
  );
}

/** Clamp text to a char budget, preferring a line boundary near the cut. */
function clampGuidance(text: string, budget: number): string {
  const t = text.trim();
  if (t.length <= budget) return t;
  const cut = t.slice(0, budget);
  const nl = cut.lastIndexOf("\n");
  // Only honor a line boundary if it keeps most of the budget.
  if (nl >= budget * 0.5) return cut.slice(0, nl).trimEnd();
  return cut.trimEnd();
}

/**
 * Build a DRAFT operator profile from example-bank items via one local-LLM call.
 * Defensive throughout: empty input, empty model output, and oversized fields all
 * yield a valid DraftProposal.
 */
export async function synthesizeProfile(
  llm: LocalLLM,
  examples: ExampleBankItem[],
  scope: string,
  opts: SynthesizeOpts,
): Promise<DraftProposal> {
  const maxExamples = opts.maxExamples ?? DEFAULT_MAX_EXAMPLES;
  const maxFewShot = opts.maxFewShot ?? DEFAULT_MAX_FEWSHOT;
  const budget = opts.guidanceCharBudget ?? DEFAULT_GUIDANCE_BUDGET;

  const fromPastSessions =
    opts.pastCount ?? examples.filter((e) => e.source === "past").length;
  const fromLiveCorrections =
    opts.liveCount ?? examples.filter((e) => e.source === "live").length;

  const ranked = rank(examples);
  const fewShot = ranked.slice(0, maxFewShot).map((e) => ({
    situation: e.situation,
    instruction: e.instruction,
  }));

  const baseDraft = {
    schema: 1 as const,
    scope,
    examples: fewShot,
    meta: {
      fromPastSessions,
      fromLiveCorrections,
      model: opts.model,
    },
  };

  const wrap = (
    draft: DraftProposal["draft"],
  ): DraftProposal => ({
    schema: 1,
    scope,
    draft,
    baseVersion: opts.baseVersion ?? null,
    createdAt: Date.now(),
    eval: null,
  });

  // Nothing to learn from — return a valid, honest draft without calling the LLM.
  if (ranked.length === 0) {
    return wrap({ ...baseDraft, guidance: NO_SIGNAL_GUIDANCE, examples: [] });
  }

  const rendered = ranked
    .slice(0, maxExamples)
    .map(
      (e) =>
        `SITUATION: ${truncate(e.situation, SITUATION_CHARS)}\n` +
        `INSTRUCTION: ${truncate(e.instruction, INSTRUCTION_CHARS)}`,
    )
    .join("\n\n");

  const reply = await llm.chat([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: rendered },
  ]);

  const guidanceRaw = (reply ?? "").trim();
  const guidance = guidanceRaw
    ? clampGuidance(guidanceRaw, budget)
    : NO_PATTERN_GUIDANCE;

  return wrap({ ...baseDraft, guidance });
}
