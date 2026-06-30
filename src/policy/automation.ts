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
  /** Resolved session id for start/stop/setMode/sendMessage (never `$self`). */
  target?: string;
  /** Custom message for notify, or the body for sendMessage. */
  message?: string;
  /** Target mode for setMode. */
  mode?: "manual" | "autopilot";
  /** Webhook name for a named-webhook action. */
  webhook?: string;
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

      if (action.kind === "webhook") {
        const webhook = action.webhook?.trim();
        if (!webhook) continue;
        const key = `webhook:${webhook}`;
        if (seen.has(key)) continue;
        seen.add(key);
        plan.push({ ruleId: rule.id, ruleName: rule.name, kind: "webhook", webhook });
        continue;
      }

      // start / stop / setMode / sendMessage — all target a session
      const target = resolveTarget(action.target, firing);
      if (!target) continue; // unresolvable target
      if (action.kind === "start" && target === firing.id) continue; // self-start loop guard

      if (action.kind === "setMode") {
        const key = `setMode:${target}:${action.mode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        plan.push({ ruleId: rule.id, ruleName: rule.name, kind: "setMode", target, mode: action.mode });
        continue;
      }
      if (action.kind === "sendMessage") {
        const message = action.message?.trim();
        if (!message) continue; // an empty message is a no-op
        const key = `sendMessage:${target}:${message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        plan.push({ ruleId: rule.id, ruleName: rule.name, kind: "sendMessage", target, message });
        continue;
      }

      // start / stop
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

// ── chain-depth guard ───────────────────────────────────────────────────────────
//
// Automation rules can cascade across lifecycle events: rule X starts session B,
// B finishes, that fires rule Y which starts C, and so on. Because each hop is a
// separate async event (not a call stack), an accidental loop ("when any session
// is done, start deploy" + "when deploy is done, start tests" + …) would fire
// forever. We tag each session with the causal *generation* of its current run —
// a user/schedule/dependency start is generation 0 (a root), and any session an
// automation starts/affects inherits generation = parent + 1. When the next hop
// would exceed the cap, the supervisor drops those actions and records a firing.

/** Default max automation hops in one causal chain before further actions drop. */
export const DEFAULT_CHAIN_CAP = 8;

/** The generation actions spawn from a session whose run is at `parentGen` (root → 1). */
export function nextChainGen(parentGen: number | undefined): number {
  const base = Number.isFinite(parentGen) && (parentGen as number) > 0 ? Math.floor(parentGen as number) : 0;
  return base + 1;
}

/** True when a generation exceeds the cap. A cap ≤ 0 disables the guard (unlimited). */
export function overChainCap(gen: number, cap: number): boolean {
  return cap > 0 && gen > cap;
}

/** Combined decision the supervisor needs for one hop: the next generation + whether it's capped. */
export function chainGuard(parentGen: number | undefined, cap: number): { gen: number; over: boolean } {
  const gen = nextChainGen(parentGen);
  return { gen, over: overChainCap(gen, cap) };
}
