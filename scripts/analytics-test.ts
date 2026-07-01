/**
 * Deterministic test for session analytics: buildAnalytics aggregates a seeded
 * store into per-session + fleet metrics, and analyticsToCsv serializes it.
 * No LLM, no network — a temp DB seeded with runs/turns/decisions/feedback.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db/store.js";
import { buildAnalytics, analyticsToCsv, percentile, latencyStats } from "../src/server/analytics.js";
import { emptyLearningSummary } from "../src/learning/service.js";

const dir = mkdtempSync(join(tmpdir(), "agi-analytics-"));
const store = openStore(join(dir, "a.db"));

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// --- session A: 2 runs (1 ended, 1 error), decisions + thumbs, an intervention -
store.upsertSession({ id: "A", cwd: "x", goal: "Build the API", doneCriteria: "d" });
const a1 = store.startRun("A");
for (let n = 1; n <= 3; n++) {
  const t = store.addTurn(a1, { n, prompt: `p${n}`, assistantText: `did ${n}`, durationMs: 10, gatesHandled: 0 });
  store.addDecision(t, { action: n === 3 ? "stop" : "continue", prompt: "x", reason: "r" });
}
store.addEvent({ sessionId: "A", runId: a1, type: "attention", payload: {} }); // needed a human
store.setDecisionFeedback("A", a1, 1, "up");
store.setDecisionFeedback("A", a1, 2, "down");
store.endRun(a1, "ended", { turns: 3, elapsedMin: 5 });
const a2 = store.startRun("A");
const at = store.addTurn(a2, { n: 1, prompt: "go", assistantText: "boom", durationMs: 5, gatesHandled: 0 });
store.addDecision(at, { action: "escalate", prompt: "", reason: "need you" });
store.endRun(a2, "error", { turns: 1, stopReason: "crashed" });

// --- session B: 1 clean run, no feedback ------------------------------------
store.upsertSession({ id: "B", cwd: "y", goal: "Docs", doneCriteria: "d" });
const b1 = store.startRun("B");
const bt = store.addTurn(b1, { n: 1, prompt: "go", assistantText: "ok", durationMs: 5, gatesHandled: 0 });
store.addDecision(bt, { action: "stop", prompt: "", reason: "done" });
store.endRun(b1, "ended", { turns: 1, elapsedMin: 2 });

const a = buildAnalytics(store, emptyLearningSummary(), { nowMs: 1_900_000_000_000 });

// --- fleet ------------------------------------------------------------------
check("fleet sessions = 2", a.fleet.sessions === 2);
check("fleet runs = 3", a.fleet.runs === 3);
check("fleet turns = 5 (3+1+1)", a.fleet.turns === 5);
check("fleet success rate = 2/3 ended of 3 finished ≈ 0.67", a.fleet.successRate === 0.67);
check("fleet decisions: continue 2", a.fleet.decisions.continue === 2);
check("fleet decisions: stop 2 (A turn3 + B)", a.fleet.decisions.stop === 2);
check("fleet decisions: escalate 1", a.fleet.decisions.escalate === 1);
check("fleet thumbs up 1 / down 1", a.fleet.feedback.up === 1 && a.fleet.feedback.down === 1);

// --- per-session (busiest first → A then B) ----------------------------------
const A = a.sessions.find((s) => s.id === "A")!;
const B = a.sessions.find((s) => s.id === "B")!;
check("sessions sorted busiest-first (A before B)", a.sessions[0]?.id === "A");
check("A runs = 2", A.runs === 2);
check("A completed 1 / errored 1", A.completedRuns === 1 && A.erroredRuns === 1);
check("A success rate = 0.5", A.successRate === 0.5);
check("A intervention rate = 0.5 (1 of 2 runs)", A.interventionRate === 0.5);
check("A escalate decision counted", A.decisions.escalate === 1);
check("A goal carried through", A.goal === "Build the API");
check("B success rate = 1 (clean)", B.successRate === 1);
check("B has no feedback", B.feedback.up === 0 && B.feedback.down === 0);

// --- error rate (complement of success among finished runs) ------------------
check("fleet error rate ≈ 0.33 (1 of 3 finished errored)", a.fleet.errorRate === 0.33);
check("A error rate = 0.5", A.errorRate === 0.5);
check("B error rate = 0", B.errorRate === 0);

// --- latency percentiles (from seeded turn durations) ------------------------
// A turns: [10,10,10] (run1) + [5] (run2) → sorted [5,10,10,10]
check("A latency count = 4 turns measured", A.latency.count === 4);
check("A latency avg = 9ms (round 8.75)", A.latency.avgMs === 9);
check("A latency p50 = 10, p95 = 10, max = 10", A.latency.p50Ms === 10 && A.latency.p95Ms === 10 && A.latency.maxMs === 10);
// fleet: A[5,10,10,10] + B[5] → [5,5,10,10,10]
check("fleet latency count = 5", a.fleet.latency.count === 5);
check("fleet latency avg = 8ms", a.fleet.latency.avgMs === 8);
check("fleet latency max = 10ms", a.fleet.latency.maxMs === 10);

// --- pure helpers (percentile / latencyStats) -------------------------------
check("percentile: empty → 0", percentile([], 95) === 0);
check("percentile: p95 of 1..20 = 19 (nearest-rank)", percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95) === 19);
check("percentile: p50 of 1..10 = 5", percentile([1,2,3,4,5,6,7,8,9,10], 50) === 5);
check("percentile: p100 = max", percentile([3,7,9], 100) === 9);
const ls = latencyStats([30, 10, 20]);
check("latencyStats sorts + avgs", ls.count === 3 && ls.avgMs === 20 && ls.maxMs === 30 && ls.p50Ms === 20);
check("latencyStats empty → zeros", latencyStats([]).count === 0 && latencyStats([]).p95Ms === 0);

// --- learning summary folds in ----------------------------------------------
check("learning fields present", typeof a.learning.totalExamples === "number" && a.learning.projectProfiles === 0);

// --- CSV --------------------------------------------------------------------
const csv = analyticsToCsv(a);
const lines = csv.trim().split("\n");
check("csv has header + fleet + 2 sessions = 4 lines", lines.length === 4);
check("csv header starts with session,goal", !!lines[0]?.startsWith("session,goal,runs"));
check("csv header includes error_rate + latency columns", !!lines[0]?.includes("error_rate") && !!lines[0]?.includes("p95_latency_ms") && !!lines[0]?.includes("avg_latency_ms"));
check("csv second row is the FLEET total", !!lines[1]?.startsWith("FLEET,"));
check("csv quotes a goal with no comma plainly", csv.includes("Build the API"));
check("csv contains both session ids", csv.includes("\nA,") && csv.includes("\nB,"));

// --- CSV escaping: a goal with a comma is quoted -----------------------------
store.upsertSession({ id: "C", cwd: "z", goal: "Refactor, test, ship", doneCriteria: "d" });
const c1 = store.startRun("C");
store.addTurn(c1, { n: 1, prompt: "p", assistantText: "x", durationMs: 1, gatesHandled: 0 });
store.endRun(c1, "ended", { turns: 1 });
const csv2 = analyticsToCsv(buildAnalytics(store, emptyLearningSummary(), { nowMs: 1_900_000_000_000 }));
check("csv quotes a field containing commas", csv2.includes('"Refactor, test, ship"'));

store.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n[analytics] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
