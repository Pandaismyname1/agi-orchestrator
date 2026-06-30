/**
 * Pure aggregation over the automation firing log. The backend ships a flat,
 * newest-first list of firings; the UI wants (a) a per-rule summary — last fired,
 * how many times, last outcome — to badge each rule, and (b) a trimmed recent
 * feed. Keeping this here (no DOM) makes the run-history logic unit-testable.
 */
import type { AutomationFiring } from "./types";

export interface RuleStats {
  /** Epoch ms of the most recent firing for this rule, or 0 if never. */
  lastFired: number;
  /** Total firings recorded for this rule (any outcome). */
  count: number;
  /** Outcome of the most recent firing. */
  lastOutcome: AutomationFiring["outcome"] | null;
  /** How many of this rule's firings were skips or errors. */
  problems: number;
}

const empty = (): RuleStats => ({ lastFired: 0, count: 0, lastOutcome: null, problems: 0 });

/**
 * Fold the firing log into a per-rule summary keyed by ruleId. Robust to any input
 * order: `lastFired`/`lastOutcome` track the genuinely newest firing by timestamp.
 */
export function summarizeFirings(log: AutomationFiring[] | undefined): Record<string, RuleStats> {
  const out: Record<string, RuleStats> = {};
  for (const f of log ?? []) {
    const s = (out[f.ruleId] ??= empty());
    s.count += 1;
    if (f.outcome !== "ok") s.problems += 1;
    if (f.at >= s.lastFired) {
      s.lastFired = f.at;
      s.lastOutcome = f.outcome;
    }
  }
  return out;
}

/** Stats for a single rule (never null — absent rules read as "never fired"). */
export function statsFor(summary: Record<string, RuleStats>, ruleId: string): RuleStats {
  return summary[ruleId] ?? empty();
}

/** The newest `limit` firings, newest first. Tolerates an already-sorted or unsorted log. */
export function recentFirings(log: AutomationFiring[] | undefined, limit = 12): AutomationFiring[] {
  return [...(log ?? [])].sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
}

/** A compact one-line label for a firing, e.g. `done → start deploy-prod`. */
export function firingLabel(f: AutomationFiring): string {
  const action = f.kind === "notify" ? "notify" : `${f.kind} ${f.target ?? ""}`.trim();
  return `${f.event} → ${action}`;
}
