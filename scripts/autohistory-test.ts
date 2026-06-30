/**
 * Deterministic tests for automation run-history aggregation
 * (web/src/lib/autohistory.ts). Pure folds over a firing log — no DOM, no clock.
 */
import {
  summarizeFirings,
  statsFor,
  recentFirings,
  firingLabel,
} from "../web/src/lib/autohistory.js";
import type { AutomationFiring } from "../web/src/lib/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const f = (over: Partial<AutomationFiring>): AutomationFiring => ({
  at: 0,
  ruleId: "r1",
  ruleName: "Rule One",
  event: "done",
  kind: "start",
  from: "a",
  target: "b",
  outcome: "ok",
  ...over,
});

// Intentionally NOT in timestamp order, to prove the fold is order-robust.
const log: AutomationFiring[] = [
  f({ ruleId: "r1", at: 100, outcome: "ok" }),
  f({ ruleId: "r1", at: 300, outcome: "skipped", note: "no such session" }),
  f({ ruleId: "r1", at: 200, outcome: "ok" }),
  f({ ruleId: "r2", at: 250, outcome: "error", kind: "stop", note: "boom" }),
  f({ ruleId: "r2", at: 50, outcome: "ok", kind: "notify", target: undefined }),
];

// ── summarizeFirings ─────────────────────────────────────────────────────────────
const sum = summarizeFirings(log);
check("counts per rule", sum.r1!.count === 3 && sum.r2!.count === 2);
check("lastFired is the genuine max timestamp", sum.r1!.lastFired === 300);
check("lastOutcome tracks the newest firing", sum.r1!.lastOutcome === "skipped");
check("problems counts non-ok firings", sum.r1!.problems === 1 && sum.r2!.problems === 1);
check("r2 lastOutcome is the newer error (250 > 50)", sum.r2!.lastOutcome === "error");

// ── statsFor (never null) ─────────────────────────────────────────────────────────
check("statsFor known rule", statsFor(sum, "r1").count === 3);
check("statsFor unknown rule reads as never-fired", statsFor(sum, "zzz").count === 0 && statsFor(sum, "zzz").lastFired === 0 && statsFor(sum, "zzz").lastOutcome === null);

// ── empty / undefined input ───────────────────────────────────────────────────────
check("summarize undefined → empty", Object.keys(summarizeFirings(undefined)).length === 0);
check("recent undefined → empty", recentFirings(undefined).length === 0);

// ── recentFirings (newest first, limited) ─────────────────────────────────────────
const recent = recentFirings(log, 3);
check("recent is newest-first", recent[0]!.at === 300 && recent[1]!.at === 250 && recent[2]!.at === 200);
check("recent respects the limit", recent.length === 3);
check("recent does not mutate input", log[0]!.at === 100);
check("recent limit 0 → empty", recentFirings(log, 0).length === 0);

// ── firingLabel ───────────────────────────────────────────────────────────────────
check("label for start", firingLabel(f({ event: "done", kind: "start", target: "deploy" })) === "done → start deploy");
check("label for stop", firingLabel(f({ event: "error", kind: "stop", target: "x" })) === "error → stop x");
check("label for notify omits target", firingLabel(f({ event: "needs-input", kind: "notify", target: undefined })) === "needs-input → notify");

console.log(`\n[autohistory] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
