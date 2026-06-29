/**
 * Advisory replay-eval (A3) — does a DRAFTED operator profile make Qwen match the
 * owner's PAST instructions better than no profile at all?
 *
 * For each held-out correction example we ask the brain to decide the next step
 * twice: once with NO learned guidance (baseline) and once with the draft's
 * guidance injected. A held-out item is a "match" when the brain chooses
 * "continue" AND its proposed prompt is close (Jaccard token overlap) to what the
 * owner actually instructed. The signal is `delta = profileMatch - baselineMatch`:
 * positive means the profile nudges Qwen toward the owner's real choices.
 *
 * This is ADVISORY only — the EvalReport is shown to the owner, never enforced.
 * Local-only: the sole network calls are `decideNextStep` → `llm.chat` against the
 * local LM Studio / Ollama endpoint (see brain/provider.ts). No cloud API.
 *
 * Defensive: each item's two calls are wrapped so one failed/garbage call counts
 * as a non-match rather than aborting the whole eval.
 */
import { decideNextStep } from "../brain/decide.js";
import type { LocalLLM } from "../brain/provider.js";
import type { SessionConfig } from "../types.js";
import type { EvalReport, ExampleBankItem } from "./types.js";
import { jaccard } from "./util.js";

const DEFAULT_MATCH_THRESHOLD = 0.5;

interface ReplayEvalOpts {
  /** Synthetic session goal (replay context only). */
  goal?: string;
  /** Synthetic session done-criteria (replay context only). */
  doneCriteria?: string;
  /** Min Jaccard overlap of prompt↔owner-instruction to count a match (default 0.5). */
  matchThreshold?: number;
}

/**
 * Run the brain once for a held-out situation with the given learned guidance and
 * report whether its decision MATCHES the owner's recorded instruction. A match =
 * action "continue" with a prompt whose token overlap with `instruction` clears
 * the threshold. Any thrown call is swallowed and counts as a non-match.
 */
async function isMatch(
  llm: LocalLLM,
  session: SessionConfig,
  situation: string,
  instruction: string,
  learnedGuidance: string,
  threshold: number,
): Promise<boolean> {
  try {
    const decision = await decideNextStep(llm, session, situation, 2, undefined, learnedGuidance);
    return (
      decision.action === "continue" &&
      jaccard(decision.prompt ?? "", instruction) >= threshold
    );
  } catch {
    // A failed/garbage call is treated as "did not match" — never fatal.
    return false;
  }
}

/**
 * Replay each held-out correction through the brain with and without the draft
 * guidance, and tally how often each variant matched the owner's instruction.
 * Returns an advisory EvalReport (shown, not enforced).
 */
export async function replayEval(
  llm: LocalLLM,
  heldOut: ExampleBankItem[],
  draftGuidance: string,
  opts?: ReplayEvalOpts,
): Promise<EvalReport> {
  const total = heldOut.length;

  if (total === 0) {
    return {
      schema: 1,
      total: 0,
      baselineMatch: 0,
      profileMatch: 0,
      matchRate: 0,
      delta: 0,
      ranAt: Date.now(),
      note: "no held-out corrections to evaluate",
    };
  }

  const threshold = opts?.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const session: SessionConfig = {
    id: "eval",
    cwd: "",
    goal: opts?.goal ?? "(replay eval)",
    doneCriteria: opts?.doneCriteria ?? "(replay eval)",
    autonomy: "balanced",
  };

  let baselineMatch = 0;
  let profileMatch = 0;

  for (const item of heldOut) {
    // Baseline: no learned guidance. With profile: the draft's guidance.
    if (await isMatch(llm, session, item.situation, item.instruction, "", threshold)) {
      baselineMatch++;
    }
    if (await isMatch(llm, session, item.situation, item.instruction, draftGuidance, threshold)) {
      profileMatch++;
    }
  }

  return {
    schema: 1,
    total,
    baselineMatch,
    profileMatch,
    matchRate: profileMatch / total,
    delta: profileMatch - baselineMatch,
    ranAt: Date.now(),
  };
}
