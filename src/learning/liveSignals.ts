/**
 * Live "manual override" signals for the learning loop (A3).
 *
 * Derives correction examples straight from the SQLite store — no new schema.
 * The idea: at turn k the brain (Qwen) saw turn k-1 and proposed a "continue"
 * with some prompt; if turn k was actually injected with a DIFFERENT instruction
 * than what the brain proposed, the owner overrode the brain. That (situation,
 * instruction) pair is a high-signal example of how the owner really steers.
 *
 * Pure derivation over existing tables (turns + decisions). Defensive: never
 * throws — a bad/partial run is skipped, not fatal. Output dedupes by the shared
 * hashExample so live signals merge cleanly with mined "past" examples.
 */
import type { Store, TurnRow } from "../db/store.js";
import type { ExampleBankItem } from "./types.js";
import { hashExample, truncate, sameInstruction } from "./util.js";

/**
 * Override examples for a single run.
 *
 * For each turn k (k ≥ 2): the decision recorded for turn k-1 is the brain's
 * call after seeing turn k-1; its `.prompt` is what SHOULD have been injected as
 * turn k. An override is when the brain said "continue" with a prompt but turn k
 * carried a *different* injected_prompt — i.e. a human corrected the steer.
 */
export function deriveCorrections(store: Store, runId: number): ExampleBankItem[] {
  const turns = store.getTurns(runId);
  if (turns.length === 0) return [];

  const turnByN = new Map<number, TurnRow>();
  for (const t of turns) turnByN.set(t.n, t);

  const decByN = new Map(store.getDecisions(runId).map((d) => [d.n, d] as const));

  // When the override happened — prefer the run's end, else the last turn's
  // timestamp, else now.
  const lastTurn = turns[turns.length - 1];
  let runEndedAt = lastTurn?.created_at ?? Date.now();
  try {
    const run = store.getRun(runId);
    if (run?.ended_at != null) runEndedAt = run.ended_at;
  } catch {
    /* getRun is best-effort; fall back to the turn timestamp */
  }

  const byHash = new Map<string, ExampleBankItem>();

  for (const turn of turns) {
    const k = turn.n;
    if (k < 2) continue;

    const prevDecision = decByN.get(k - 1);
    if (!prevDecision || prevDecision.action !== "continue") continue;

    const proposed = prevDecision.prompt;
    const actual = turn.injected_prompt;
    if (!proposed || !proposed.trim()) continue;
    if (!actual || !actual.trim()) continue;

    // Same instruction → the brain's steer was followed, not overridden.
    if (sameInstruction(actual, proposed)) continue;

    // The human reacted to claude's reply at turn k-1.
    const situation = turnByN.get(k - 1)?.assistant_text;
    if (!situation || !situation.trim()) continue;

    const sit = truncate(situation, 300);
    const ins = truncate(actual, 300);
    const hash = hashExample(situation, actual);
    if (byHash.has(hash)) continue;

    byHash.set(hash, {
      situation: sit,
      instruction: ins,
      source: "live",
      hash,
      count: 1,
      lastSeen: runEndedAt,
    });
  }

  return [...byHash.values()];
}

/**
 * Override examples across the most recent `runLimit` runs, deduped by hash
 * (count bumped, max lastSeen kept). Per-run derivation is wrapped so one bad
 * run can never sink the batch.
 */
export function deriveRecentCorrections(store: Store, runLimit = 50): ExampleBankItem[] {
  let runs: ReturnType<Store["getRuns"]>;
  try {
    runs = store.getRuns(undefined, runLimit);
  } catch {
    return [];
  }

  const byHash = new Map<string, ExampleBankItem>();

  for (const run of runs) {
    let items: ExampleBankItem[];
    try {
      items = deriveCorrections(store, run.id);
    } catch {
      continue;
    }

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

  return [...byHash.values()];
}
