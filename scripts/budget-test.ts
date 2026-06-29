/**
 * Deterministic test of the daily budget guard. Pre-seeds the store with today's
 * usage, then checks BudgetTracker math and that the Supervisor refuses to start
 * a session once the daily turn budget is spent. No claude, no LLM.
 */
import { rmSync } from "node:fs";
import { openStore } from "../src/db/store.js";
import { BudgetTracker } from "../src/policy/budget.js";
import { Supervisor } from "../src/server/supervisor.js";
import type { AppConfig } from "../src/types.js";

const DB = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\budget-test.db";
rmSync(DB, { force: true });
const store = openStore(DB);

// Seed: one completed run today that used 5 turns / 12 minutes.
store.upsertSession({ id: "seed", cwd: "x", goal: "g", doneCriteria: "d" });
const runId = store.startRun("seed");
store.endRun(runId, "ended", { turns: 5, elapsedMin: 12 });

let pass = true;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); if (!c) pass = false; };

// BudgetTracker math
const t1 = new BudgetTracker(store, { maxTurnsPerDay: 5 }).status();
check("turns counted from store (5)", t1.turns === 5);
check("exceeded at limit (5/5)", t1.exceeded === true);

const t2 = new BudgetTracker(store, { maxTurnsPerDay: 100 }).status();
check("under budget not exceeded", t2.exceeded === false);

const t3 = new BudgetTracker(store, { maxMinutesPerDay: 10 }).status();
check("minute budget exceeded (12/10)", t3.exceeded === true);

const t4 = new BudgetTracker(store, undefined).status();
check("no budget => never exceeded", t4.exceeded === false);

// Supervisor refuses to start when the daily budget is already spent.
const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:1234/v1", model: "unused", apiKey: "local" },
  limits: { maxTurns: 25, maxWallClockMin: 60, pingPongThreshold: 3 },
  budget: { maxTurnsPerDay: 5 },
  sessions: [{ id: "blocked-one", cwd: "x", goal: "g", doneCriteria: "d", permissionMode: "acceptEdits" }],
};
const sup = new Supervisor(cfg, store);
sup.start("blocked-one");
const v = sup.list().find((s) => s.id === "blocked-one")!;
check("supervisor refuses start (stays idle)", v.status === "idle");
check("blocked reason surfaced", /blocked/i.test(v.lastDecision));
check("budgetStatus exposed + exceeded", sup.budgetStatus().exceeded === true);

store.close();
rmSync(DB, { force: true });
rmSync(DB + "-shm", { force: true });
rmSync(DB + "-wal", { force: true });
console.log(`\n[budget] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
