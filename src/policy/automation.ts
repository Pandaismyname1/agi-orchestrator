/**
 * Automation rules engine — the unifying layer over webhooks + dependencies.
 *
 * When a session reaches a lifecycle event (done / error / stopped / needs-input
 * / rate-limited), the supervisor asks this engine which actions to run. The
 * engine is PURE: given the event, the firing session, and the rule list, it
 * returns a flat, deduped plan of concrete actions. The supervisor executes them
 * (start/stop a session, fire a notification) — so this module has no side
 * effects and is fully unit-testable, and it makes NO model calls (local-safe).
 *
 * Generalizes the dependency DAG ("start B when A is done") to any event/action
 * pair ("when A errors, stop B and notify"), without replacing it.
 */
import type {
  AutomationRule,
  AutomationAction,
  AutomationTrigger,
  AutomationMatch,
  WebhookEvent,
} from "../types.js";

/** The literal `target` value meaning "the session that fired the event". */
export const SELF = "$self";

/** The slice of the firing session the engine reads to evaluate `match`. */
export interface FiringSession {
  id: string;
  cwd?: string;
  goal?: string;
  mode?: string;
}

/** A concrete action the supervisor should perform, tagged with its source rule. */
export interface PlannedAction {
  ruleId: string;
  ruleName: string;
  kind: AutomationAction["kind"];
  /** Resolved session id for start/stop (never `$self` — already resolved). */
  target?: string;
  /** Custom message for notify (optional). */
  message?: string;
}

const ci = (s: string | undefined): string => (s ?? "").toLowerCase();

/** True unless the rule is explicitly disabled. */
export function ruleEnabled(rule: AutomationRule): boolean {
  return rule.enabled !== false;
}

/** Does this rule trigger on `event`? Empty/undefined `on` = every event. */
export function triggersOn(rule: AutomationRule, event: WebhookEvent): boolean {
  if (!rule.on || rule.on.length === 0) return true;
  return rule.on.includes(event as AutomationTrigger);
}

/** Does the firing session satisfy a rule's `match` filter? (all clauses AND-ed) */
export function matchesSession(match: AutomationMatch | undefined, s: FiringSession): boolean {
  if (!match) return true;
  if (match.sessionId && match.sessionId !== s.id) return false;
  if (match.cwdContains && !ci(s.cwd).includes(ci(match.cwdContains))) return false;
  if (match.goalContains && !ci(s.goal).includes(ci(match.goalContains))) return false;
  if (match.mode && match.mode !== s.mode) return false;
  return true;
}

/** Resolve an action `target` (`$self` → the firing session's id). */
export function resolveTarget(target: string, firing: FiringSession): string {
  return target === SELF ? firing.id : target;
}

/**
 * Plan the actions for one lifecycle event. Returns a deduped list of concrete
 * actions, in rule-then-action order.
 *
 * Loop safety: a `start` whose resolved target is the firing session is dropped
 * (a session can't re-start itself from its own completion — that's an instant
 * loop). `stop $self` is kept (stopping yourself is terminal, not a loop). Exact
 * duplicate actions (same kind + target) collapse to one.
 */
export function planAutomations(
  event: WebhookEvent,
  firing: FiringSession,
  rules: AutomationRule[] | undefined,
): PlannedAction[] {
  if (!rules || rules.length === 0) return [];
  const plan: PlannedAction[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    if (!ruleEnabled(rule)) continue;
    if (!triggersOn(rule, event)) continue;
    if (!matchesSession(rule.match, firing)) continue;

    for (const action of rule.actions ?? []) {
      if (action.kind === "notify") {
        const message = action.message?.trim() || undefined;
        const key = `notify:${rule.id}:${message ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        plan.push({ ruleId: rule.id, ruleName: rule.name, kind: "notify", message });
        continue;
      }

      // start / stop
      const target = resolveTarget(action.target, firing);
      if (!target) continue; // unresolvable target
      if (action.kind === "start" && target === firing.id) continue; // self-start loop guard
      const key = `${action.kind}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plan.push({ ruleId: rule.id, ruleName: rule.name, kind: action.kind, target });
    }
  }
  return plan;
}

/** Count of enabled rules (handy for "automations active" UI/skip checks). */
export function countEnabled(rules: AutomationRule[] | undefined): number {
  return (rules ?? []).filter(ruleEnabled).length;
}
