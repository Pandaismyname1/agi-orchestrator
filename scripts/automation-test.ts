/**
 * Deterministic tests for the automation rules engine (src/policy/automation.ts).
 * Pure logic — no supervisor, no network. Covers trigger/match filtering, $self
 * resolution, the self-start loop guard, dedup, and disabled/empty handling.
 */
import {
  planAutomations,
  matchesSession,
  triggersOn,
  resolveTarget,
  countEnabled,
  SELF,
  type FiringSession,
} from "../src/policy/automation.js";
import type { AutomationRule } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const now = 1_700_000_000_000;
const rule = (r: Partial<AutomationRule>): AutomationRule => ({
  id: r.id ?? "r1",
  name: r.name ?? "rule",
  enabled: r.enabled,
  on: r.on,
  match: r.match,
  actions: r.actions ?? [],
  createdAt: now,
  updatedAt: now,
});

const firing: FiringSession = { id: "api", cwd: "C:\\dev\\api", goal: "Build the REST API", mode: "autopilot" };
const plan = (event: any, rules: AutomationRule[]) => planAutomations(event, firing, rules);

// ── trigger filtering ───────────────────────────────────────────────────────────
check("on:[done] fires on done", triggersOn(rule({ on: ["done"] }), "done"));
check("on:[done] does NOT fire on error", !triggersOn(rule({ on: ["done"] }), "error"));
check("empty on:[] fires on any event", triggersOn(rule({ on: [] }), "error") && triggersOn(rule({}), "stopped"));

// ── match filtering ──────────────────────────────────────────────────────────────
check("no match clause matches all", matchesSession(undefined, firing));
check("sessionId exact match", matchesSession({ sessionId: "api" }, firing));
check("sessionId mismatch rejects", !matchesSession({ sessionId: "web" }, firing));
check("cwdContains case-insensitive", matchesSession({ cwdContains: "DEV\\api" }, firing));
check("goalContains substring", matchesSession({ goalContains: "rest api" }, firing));
check("mode filter", matchesSession({ mode: "autopilot" }, firing) && !matchesSession({ mode: "manual" }, firing));
check("clauses AND together (one fails → no match)", !matchesSession({ sessionId: "api", mode: "manual" }, firing));

// ── target resolution ────────────────────────────────────────────────────────────
check("$self resolves to firing id", resolveTarget(SELF, firing) === "api");
check("explicit id passes through", resolveTarget("deploy", firing) === "deploy");

// ── planning: a real rule ────────────────────────────────────────────────────────
const onErrorNotifyAndStop = rule({
  id: "guard",
  name: "Halt on error",
  on: ["error"],
  actions: [{ kind: "notify", message: "API broke" }, { kind: "stop", target: SELF }],
});
const p1 = plan("error", [onErrorNotifyAndStop]);
check("fires both actions on matching event", p1.length === 2);
check("notify action carries message", p1[0]!.kind === "notify" && p1[0]!.message === "API broke");
check("stop $self resolves target to firing id", p1[1]!.kind === "stop" && p1[1]!.target === "api");
check("planned actions tag their source rule", p1[0]!.ruleId === "guard" && p1[0]!.ruleName === "Halt on error");
check("non-matching event → empty plan", plan("done", [onErrorNotifyAndStop]).length === 0);

// ── chaining: when A done, start B ────────────────────────────────────────────────
const startDeploy = rule({ id: "chain", on: ["done"], actions: [{ kind: "start", target: "deploy" }] });
const p2 = plan("done", [startDeploy]);
check("start action targets another session", p2.length === 1 && p2[0]!.kind === "start" && p2[0]!.target === "deploy");

// ── loop guard: a rule can't start the firing session itself ──────────────────────
const selfStart = rule({ id: "loop", on: ["done"], actions: [{ kind: "start", target: SELF }] });
check("self-start is dropped (loop guard)", plan("done", [selfStart]).length === 0);
check("but stop $self is allowed", plan("done", [rule({ on: ["done"], actions: [{ kind: "stop", target: SELF }] })]).length === 1);

// ── dedup ────────────────────────────────────────────────────────────────────────
const dupes = [
  rule({ id: "a", on: ["error"], actions: [{ kind: "stop", target: "x" }] }),
  rule({ id: "b", on: ["error"], actions: [{ kind: "stop", target: "x" }] }),
];
check("duplicate start/stop targets collapse", plan("error", dupes).length === 1);

// ── disabled / empty ─────────────────────────────────────────────────────────────
check("disabled rule never fires", plan("error", [rule({ enabled: false, on: ["error"], actions: [{ kind: "stop", target: "x" }] })]).length === 0);
check("empty rule list → empty plan", plan("error", []).length === 0);
check("undefined rules → empty plan", planAutomations("error", firing, undefined).length === 0);
check("countEnabled ignores disabled", countEnabled([rule({}), rule({ enabled: false })]) === 1);

// ── match gates the whole rule ────────────────────────────────────────────────────
const scoped = rule({ on: ["error"], match: { sessionId: "web" }, actions: [{ kind: "stop", target: "x" }] });
check("rule whose match fails contributes nothing", plan("error", [scoped]).length === 0);

// ── richer actions: setMode / sendMessage / webhook ───────────────────────────────
const sm = plan("done", [rule({ on: ["done"], actions: [{ kind: "setMode", target: "db", mode: "manual" }] })]);
check("setMode planned with target + mode", sm.length === 1 && sm[0]!.kind === "setMode" && sm[0]!.target === "db" && sm[0]!.mode === "manual");
check("setMode resolves $self", plan("done", [rule({ actions: [{ kind: "setMode", target: SELF, mode: "autopilot" }] })])[0]!.target === "api");

const msg = plan("needs-input", [rule({ actions: [{ kind: "sendMessage", target: "db", message: "  proceed  " }] })]);
check("sendMessage planned with trimmed message", msg.length === 1 && msg[0]!.kind === "sendMessage" && msg[0]!.message === "proceed" && msg[0]!.target === "db");
check("sendMessage with empty message is dropped", plan("done", [rule({ actions: [{ kind: "sendMessage", target: "db", message: "   " }] })]).length === 0);

const wh = plan("error", [rule({ actions: [{ kind: "webhook", webhook: "pager" }] })]);
check("webhook planned by name (no target)", wh.length === 1 && wh[0]!.kind === "webhook" && wh[0]!.webhook === "pager" && wh[0]!.target === undefined);
check("webhook with blank name is dropped", plan("done", [rule({ actions: [{ kind: "webhook", webhook: "  " }] })]).length === 0);

// dedup across new kinds
const dupMode = plan("done", [rule({ actions: [{ kind: "setMode", target: "db", mode: "manual" }, { kind: "setMode", target: "db", mode: "manual" }] })]);
check("duplicate setMode collapses", dupMode.length === 1);
check("setMode differing mode is NOT a dup", plan("done", [rule({ actions: [{ kind: "setMode", target: "db", mode: "manual" }, { kind: "setMode", target: "db", mode: "autopilot" }] })]).length === 2);

// mixed action set keeps order
const mixed = plan("done", [rule({ actions: [{ kind: "setMode", target: "db", mode: "manual" }, { kind: "webhook", webhook: "pager" }, { kind: "start", target: "deploy" }] })]);
check("mixed actions all planned in order", mixed.map((p) => p.kind).join(",") === "setMode,webhook,start");

console.log(`\n[automation] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
