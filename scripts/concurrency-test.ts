/**
 * Deterministic test of the concurrency cap + queue. Injects a fake runner (no
 * claude, no LLM) that "runs" for 300ms, then asserts that no more than
 * maxConcurrent sessions run at once and the rest queue and drain in order.
 */
import { Supervisor, type RunFn } from "../src/server/supervisor.js";
import type { AppConfig } from "../src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fake session: emit start, "run" for 300ms, emit stop, resolve.
const runner: RunFn = (session, opts) =>
  new Promise((resolve) => {
    opts.onEvent?.({ type: "start", sessionId: session.id, goal: session.goal });
    setTimeout(() => {
      opts.onEvent?.({ type: "stop", sessionId: session.id, reason: "done", turns: 1, elapsedMin: 0.1 });
      resolve();
    }, 300);
  });

const mkCfg = (maxConcurrent: number, n: number): AppConfig => ({
  provider: { baseUrl: "x", model: "x", apiKey: "local" },
  limits: { maxTurns: 5, maxWallClockMin: 60, pingPongThreshold: 3 },
  maxConcurrent,
  sessions: Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`, cwd: "x", goal: "g", doneCriteria: "d", permissionMode: "acceptEdits" as const,
  })),
});

let pass = true;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); if (!c) pass = false; };
const count = (sup: Supervisor, st: string) => sup.list().filter((s) => s.status === st).length;

// --- cap 2 over 4 sessions ---
const sup = new Supervisor(mkCfg(2, 4), undefined, undefined, runner);
sup.startAll();
check("immediately 2 running", count(sup, "running") === 2);
check("immediately 2 queued", count(sup, "queued") === 2);

let maxRunning = 0;
for (let i = 0; i < 16; i++) { // ~800ms
  maxRunning = Math.max(maxRunning, count(sup, "running"));
  await sleep(50);
}
check("never exceeded cap (<=2)", maxRunning <= 2);
check("cap was saturated (==2)", maxRunning === 2);
check("all 4 done", count(sup, "done") === 4);

// --- stop a queued session (cap 1 over 3) ---
const sup2 = new Supervisor(mkCfg(1, 3), undefined, undefined, runner);
sup2.startAll();
check("cap1: 1 running, 2 queued", count(sup2, "running") === 1 && count(sup2, "queued") === 2);
sup2.stop("s3"); // cancel a queued one
check("stopped queued -> idle", sup2.list().find((s) => s.id === "s3")?.status === "idle");
await sleep(1200);
const final = sup2.list();
check("s1 & s2 done", final.filter((s) => ["s1", "s2"].includes(s.id)).every((s) => s.status === "done"));
check("cancelled s3 never ran (idle)", final.find((s) => s.id === "s3")?.status === "idle");

console.log(`\n[concurrency] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
