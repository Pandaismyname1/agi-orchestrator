/**
 * Deterministic test of the observability layer: seed runs/turns/decisions/events
 * and verify the store's history + metrics read methods. No claude, no LLM.
 */
import { rmSync } from "node:fs";
import { openStore } from "../src/db/store.js";

const DB = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\obs-test.db";
for (const s of ["", "-shm", "-wal"]) rmSync(DB + s, { force: true });
const store = openStore(DB);

let pass = true;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); if (!c) pass = false; };

// Run A: 3 turns, escalated once (needed a human) -> ended.
store.upsertSession({ id: "A", cwd: "x", goal: "g", doneCriteria: "d" });
const rA = store.startRun("A");
for (let n = 1; n <= 3; n++) {
  const tid = store.addTurn(rA, { n, prompt: `step ${n}`, assistantText: `did ${n}`, durationMs: 1000, gatesHandled: 0 });
  store.addDecision(tid, { action: n === 3 ? "stop" : "continue", prompt: `step ${n + 1}`, reason: "r" });
}
store.addEvent({ sessionId: "A", runId: rA, type: "attention", payload: { q: "?" } });
store.endRun(rA, "ended", { turns: 3, elapsedMin: 5 });

// Run B: 1 turn, no human -> error.
store.upsertSession({ id: "B", cwd: "x", goal: "g", doneCriteria: "d" });
const rB = store.startRun("B");
const tB = store.addTurn(rB, { n: 1, prompt: "go", assistantText: "boom", durationMs: 500, gatesHandled: 0 });
store.addDecision(tB, { action: "continue", prompt: "next", reason: "r" });
store.endRun(rB, "error", { turns: 1, elapsedMin: 1, stopReason: "crashed" });

// ---- metrics (global) ----
const m = store.metrics();
check("global runs=2", m.runs === 2);
check("global turns=4", m.turns === 4);
check("global avgTurns=2", m.avgTurns === 2);
check("interventionRuns=1", m.interventionRuns === 1);
check("interventionRate=0.5", m.interventionRate === 0.5);
check("byStatus ended=1 error=1", m.byStatus.ended === 1 && m.byStatus.error === 1);

// ---- metrics (scoped) ----
const ma = store.metrics("A");
check("A runs=1 intervention=1 rate=1", ma.runs === 1 && ma.interventionRuns === 1 && ma.interventionRate === 1);

// ---- timeline reads ----
check("getRun(rA).turns=3", store.getRun(rA)?.turns === 3);
check("getTurns(rA).length=3", store.getTurns(rA).length === 3);
const dec = store.getDecisions(rA);
check("getDecisions(rA): 3, last=stop", dec.length === 3 && dec[2]?.action === "stop");
check("getEvents(rA) has attention", store.getEvents(rA).some((e) => e.type === "attention"));
check("getRun(missing)=null", store.getRun(99999) === null);

store.close();
for (const s of ["", "-shm", "-wal"]) rmSync(DB + s, { force: true });
console.log(`\n[obs] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
