/**
 * Deterministic tests for persisted fleet prefs (web/src/lib/prefs.ts).
 * Pure parse/serialize/coerce — no DOM/localStorage. Verifies validation,
 * fail-soft defaults, query clamping, and round-tripping.
 */
import {
  parseFleetPrefs,
  serializeFleetPrefs,
  coerceSortKey,
  defaultFleetPrefs,
  type FleetPrefs,
} from "../web/src/lib/prefs.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── defaults ──────────────────────────────────────────────────────────────────
const d = defaultFleetPrefs();
check("default sort is attention", d.sortKey === "attention");
check("default query is empty", d.query === "");

// ── coerceSortKey ─────────────────────────────────────────────────────────────
check("valid key passes through", coerceSortKey("turns") === "turns");
check("every known key is valid", ["attention", "name", "turns", "runtime"].every((k) => coerceSortKey(k) === k));
check("unknown key → attention", coerceSortKey("bogus") === "attention");
check("non-string → attention", coerceSortKey(42) === "attention" && coerceSortKey(null) === "attention" && coerceSortKey(undefined) === "attention");

// ── parseFleetPrefs (fail-soft) ───────────────────────────────────────────────
check("null → defaults", JSON.stringify(parseFleetPrefs(null)) === JSON.stringify(d));
check("empty string → defaults", JSON.stringify(parseFleetPrefs("")) === JSON.stringify(d));
check("garbage JSON → defaults", JSON.stringify(parseFleetPrefs("{not json")) === JSON.stringify(d));
check("valid stored prefs parse", JSON.stringify(parseFleetPrefs('{"sortKey":"runtime","query":"api"}')) === JSON.stringify({ sortKey: "runtime", query: "api" }));
check("invalid sortKey in JSON coerced", parseFleetPrefs('{"sortKey":"xxx","query":"y"}').sortKey === "attention");
check("non-string query → empty", parseFleetPrefs('{"sortKey":"name","query":123}').query === "");
check("missing fields → defaults per field", JSON.stringify(parseFleetPrefs("{}")) === JSON.stringify(d));

// ── query clamping ────────────────────────────────────────────────────────────
const long = "x".repeat(500);
check("parse clamps a long query to 200", parseFleetPrefs(JSON.stringify({ sortKey: "name", query: long })).query.length === 200);
check("serialize clamps a long query to 200", parseFleetPrefs(serializeFleetPrefs({ sortKey: "name", query: long })).query.length === 200);

// ── round-trip ────────────────────────────────────────────────────────────────
const p: FleetPrefs = { sortKey: "turns", query: "deploy" };
check("serialize → parse round-trips", JSON.stringify(parseFleetPrefs(serializeFleetPrefs(p))) === JSON.stringify(p));

console.log(`\n[prefs] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
