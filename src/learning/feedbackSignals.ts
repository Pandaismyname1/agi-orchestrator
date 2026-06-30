/**
 * Explicit-feedback signals for the learning loop.
 *
 * The owner can thumb a brain decision up or down in the dashboard (stored in
 * decisions.feedback). Those ratings are the highest-signal training data we
 * have — a direct "yes, decide like this" / "no, don't" on a real choice:
 *
 *   👍 up   → a POSITIVE example: in this agent state, steering this way is right.
 *   👎 down → a NEGATIVE (anti-)example: in this state, do NOT steer this way.
 *
 * We mine (situation, instruction) the same shape as liveSignals so feedback
 * merges into the example bank and flows through synthesis. Up-rated items are
 * weighted heavily (an explicit endorsement beats an inferred override); down-
 * rated items are tagged kind:"negative" and given a distinct hash so a positive
 * and a negative of the same text never collapse into one.
 *
 * Pure derivation over existing tables (turns + decisions); never throws.
 */
import type { Store, TurnRow } from "../db/store.js";
import type { ExampleBankItem } from "./types.js";
import { hashExample, truncate } from "./util.js";

/** Weight for an explicitly up-rated decision (above mined/override signals). */
const UP_WEIGHT = 4;
/** Weight for a down-rated decision among the anti-examples. */
const DOWN_WEIGHT = 2;

/**
 * Feedback-derived examples for a single run. For each decision the owner rated:
 *  - situation = the agent message that decision followed (turn n's assistant text)
 *  - instruction = what the brain proposed (the decision's prompt; for a "stop"
 *    decision, a synthetic "stop the session" so the signal isn't lost)
 *  - kind = positive (👍) or negative (👎)
 */
export function deriveFeedback(store: Store, runId: number): ExampleBankItem[] {
  const turns = store.getTurns(runId);
  if (turns.length === 0) return [];

  const textByN = new Map<number, TurnRow>();
  for (const t of turns) textByN.set(t.n, t);

  let runEndedAt = turns[turns.length - 1]?.created_at ?? Date.now();
  try {
    const run = store.getRun(runId);
    if (run?.ended_at != null) runEndedAt = run.ended_at;
  } catch {
    /* best-effort timestamp */
  }

  const byHash = new Map<string, ExampleBankItem>();

  for (const d of store.getDecisions(runId)) {
    if (d.feedback !== "up" && d.feedback !== "down") continue;

    const situation = textByN.get(d.n)?.assistant_text;
    if (!situation || !situation.trim()) continue;

    // What the brain proposed. "continue" carries a prompt; "stop" has none, so
    // describe the action itself; "escalate" hands off to the human (no steer).
    const instruction =
      d.action === "stop"
        ? "stop the session — we're done here"
        : (d.prompt ?? "").trim();
    if (!instruction) continue;

    const negative = d.feedback === "down";
    // Namespace negatives so a 👍 and 👎 of the same text never dedupe together.
    const hash = hashExample(situation, instruction) + (negative ? "-neg" : "");

    const existing = byHash.get(hash);
    if (existing) {
      existing.count += negative ? DOWN_WEIGHT : UP_WEIGHT;
      existing.lastSeen = Math.max(existing.lastSeen, runEndedAt);
      continue;
    }
    byHash.set(hash, {
      situation: truncate(situation, 300),
      instruction: truncate(instruction, 300),
      source: "live",
      kind: negative ? "negative" : "positive",
      hash,
      count: negative ? DOWN_WEIGHT : UP_WEIGHT,
      lastSeen: runEndedAt,
    });
  }

  return [...byHash.values()];
}

/** Merge a batch of items into a hash-keyed accumulator (count bumped, max lastSeen). */
function mergeInto(byHash: Map<string, ExampleBankItem>, items: ExampleBankItem[]): void {
  for (const item of items) {
    const existing = byHash.get(item.hash);
    if (existing) {
      existing.count += item.count;
      existing.lastSeen = Math.max(existing.lastSeen, item.lastSeen);
    } else {
      byHash.set(item.hash, { ...item });
    }
  }
}

/**
 * Feedback examples across the most recent `runLimit` runs, deduped by hash
 * (count bumped, max lastSeen kept). One bad run can never sink the batch.
 */
export function deriveRecentFeedback(store: Store, runLimit = 50): ExampleBankItem[] {
  let runs: ReturnType<Store["getRuns"]>;
  try {
    runs = store.getRuns(undefined, runLimit);
  } catch {
    return [];
  }

  const byHash = new Map<string, ExampleBankItem>();
  for (const run of runs) {
    try {
      mergeInto(byHash, deriveFeedback(store, run.id));
    } catch {
      continue;
    }
  }
  return [...byHash.values()];
}

/**
 * The same recent feedback, grouped by the run's project cwd, so a 👍/👎 on a
 * decision in project X also strengthens X's per-project profile (not just the
 * global one). `cwdOf` maps a run's session id to its absolute cwd; runs whose
 * cwd can't be resolved are skipped (they still count globally via
 * deriveRecentFeedback). Each cwd's list is independently deduped by hash.
 */
export function deriveRecentFeedbackByCwd(
  store: Store,
  cwdOf: (sessionId: string) => string | undefined,
  runLimit = 50,
): Map<string, ExampleBankItem[]> {
  let runs: ReturnType<Store["getRuns"]>;
  try {
    runs = store.getRuns(undefined, runLimit);
  } catch {
    return new Map();
  }

  const byCwd = new Map<string, Map<string, ExampleBankItem>>();
  for (const run of runs) {
    let cwd: string | undefined;
    try {
      cwd = cwdOf(run.session_id);
    } catch {
      cwd = undefined;
    }
    if (!cwd) continue;
    let items: ExampleBankItem[];
    try {
      items = deriveFeedback(store, run.id);
    } catch {
      continue;
    }
    if (items.length === 0) continue;
    let acc = byCwd.get(cwd);
    if (!acc) {
      acc = new Map();
      byCwd.set(cwd, acc);
    }
    mergeInto(acc, items);
  }

  const out = new Map<string, ExampleBankItem[]>();
  for (const [cwd, acc] of byCwd) out.set(cwd, [...acc.values()]);
  return out;
}
