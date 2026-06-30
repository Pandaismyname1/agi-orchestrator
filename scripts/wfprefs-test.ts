/**
 * Deterministic tests for persisted workflow-builder toolbar prefs
 * (web/src/lib/wfprefs.ts). Pure parse/serialize/coerce — no DOM/localStorage.
 * Verifies validation, fail-soft defaults, and round-tripping of the link mode
 * + draw event so the builder toolbar remembers choices across sessions.
 */
import {
  parseWorkflowPrefs,
  serializeWorkflowPrefs,
  coerceLinkMode,
  coerceDrawEvent,
  defaultWorkflowPrefs,
  type WorkflowPrefs,
} from "../web/src/lib/wfprefs.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── defaults ──────────────────────────────────────────────────────────────────
const d = defaultWorkflowPrefs();
check("default link mode is depends", d.linkMode === "depends");
check("default draw event is done", d.drawEvent === "done");

// ── coerceLinkMode ──────────────────────────────────────────────────────────────
check("every valid mode passes through", ["depends", "start", "stop"].every((m) => coerceLinkMode(m) === m));
check("unknown mode → depends", coerceLinkMode("explode") === "depends");
check("non-string mode → depends", coerceLinkMode(7) === "depends" && coerceLinkMode(null) === "depends" && coerceLinkMode(undefined) === "depends");

// ── coerceDrawEvent ─────────────────────────────────────────────────────────────
check("every offered event is valid", ["done", "error", "stopped", "needs-input", "rate-limited"].every((e) => coerceDrawEvent(e) === e));
check("unknown event → done", coerceDrawEvent("exploded") === "done");
check("non-string event → done", coerceDrawEvent(0) === "done" && coerceDrawEvent(null) === "done");

// ── parseWorkflowPrefs (fail-soft) ──────────────────────────────────────────────
check("null → defaults", JSON.stringify(parseWorkflowPrefs(null)) === JSON.stringify(d));
check("empty string → defaults", JSON.stringify(parseWorkflowPrefs("")) === JSON.stringify(d));
check("garbage JSON → defaults", JSON.stringify(parseWorkflowPrefs("{nope")) === JSON.stringify(d));
check("missing fields → defaults per field", JSON.stringify(parseWorkflowPrefs("{}")) === JSON.stringify(d));
check(
  "valid stored prefs parse",
  JSON.stringify(parseWorkflowPrefs('{"linkMode":"start","drawEvent":"error"}')) ===
    JSON.stringify({ linkMode: "start", drawEvent: "error" }),
);
check("invalid mode in JSON coerced", parseWorkflowPrefs('{"linkMode":"x","drawEvent":"error"}').linkMode === "depends");
check("invalid event in JSON coerced", parseWorkflowPrefs('{"linkMode":"stop","drawEvent":"x"}').drawEvent === "done");

// ── round-trip ────────────────────────────────────────────────────────────────
const p: WorkflowPrefs = { linkMode: "stop", drawEvent: "needs-input" };
check("serialize → parse round-trips", JSON.stringify(parseWorkflowPrefs(serializeWorkflowPrefs(p))) === JSON.stringify(p));

console.log(`\n[wfprefs] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
