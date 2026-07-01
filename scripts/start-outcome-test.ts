/**
 * Deterministic test: start() returns a StartOutcome so a refused start surfaces
 * a reason instead of a silent no-op (the "new sessions do nothing when I click
 * Start" bug). Uses a stub runner that stays "running" so no claude is spawned.
 */
import { Supervisor, type RunFn } from "../src/server/supervisor.js";
import type { AppConfig } from "../src/types.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:1234/v1", model: "unused", apiKey: "local" },
  limits: { maxTurns: 5, maxWallClockMin: 8, pingPongThreshold: 3 },
  sessions: [],
};

// Stub runner: never resolves, so a launched session stays "running" — lets us
// assert the "already active" refusal without spawning claude or touching an LLM.
const runner: RunFn = (s, opts) =>
  new Promise<void>(() => {
    opts.onEvent?.({ type: "start", sessionId: s.id, goal: s.goal });
  });

const sup = new Supervisor(cfg, undefined, undefined, runner);

// 1) Unknown id → refused with a clear reason (the stale-card case).
const unknown = sup.start("does-not-exist");
check("unknown id → not started", unknown.started === false);
check("unknown id → 'no such session' reason", /no such session/i.test(unknown.reason ?? ""));

// 2) A fresh session starts cleanly.
const a = sup.addSession({ cwd: "C:\\Users\\panda\\Desktop\\AGI-self", goal: "goal A", doneCriteria: "done A" });
const startA = sup.start(a.id);
check("fresh session → started", startA.started === true && !startA.reason);
check("fresh session → status running", sup.list().find((s) => s.id === a.id)?.status === "running");

// 3) Starting it again → refused, reason names the active status (not silent).
const again = sup.start(a.id);
check("already-active → not started", again.started === false);
check("already-active → reason mentions 'running'", /running/i.test(again.reason ?? ""));

// 4) A session blocked on an unfinished dependency → refused with the block reason.
const b = sup.addSession({ cwd: "C:\\Users\\panda\\Desktop\\AGI-self", goal: "goal B", doneCriteria: "done B", dependsOn: [a.id] });
const startB = sup.start(b.id);
check("dep-blocked → not started", startB.started === false);
check("dep-blocked → reason mentions 'waiting on'", /waiting on/i.test(startB.reason ?? ""));
check("dep-blocked → status blocked", sup.list().find((s) => s.id === b.id)?.status === "blocked");

console.log(`\n[start-outcome] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
