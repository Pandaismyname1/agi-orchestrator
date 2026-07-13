/**
 * Deterministic test for supervisor self-healing: a run that ends in `error`
 * schedules an automatic restart (resuming the conversation) with a bounded
 * attempt budget — instead of just parking the session dead. Uses a stub runner
 * that fails on demand; no claude, no LLM, no timers actually awaited (we assert
 * the scheduled state, not the 2-minute firing).
 */
import { Supervisor, type RunFn } from "../src/server/supervisor.js";
import type { AppConfig } from "../src/types.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};
const tick = () => new Promise((r) => setTimeout(r, 30));

const baseCfg = (): AppConfig => ({
  provider: { baseUrl: "http://localhost:1234/v1", model: "unused", apiKey: "local" },
  limits: { maxTurns: 5, maxWallClockMin: 8, pingPongThreshold: 3 },
  sessions: [],
});

// Stub runner: each launch immediately emits an error event and ends.
let errorMessage = "claude's screen was frozen for 480s and never became ready";
const failingRunner: RunFn = async (s, opts) => {
  opts.onEvent?.({ type: "start", sessionId: s.id, goal: s.goal });
  opts.onEvent?.({ type: "error", sessionId: s.id, error: errorMessage });
};

// --- default config: heal schedules, counts attempts -------------------------
{
  const sup = new Supervisor(baseCfg(), undefined, undefined, failingRunner);
  const a = sup.addSession({ cwd: "C:\\x", goal: "g", doneCriteria: "d" });
  sup.start(a.id);
  await tick();
  const v1 = sup.list().find((s) => s.id === a.id)!;
  check("errored run → status error", v1.status === "error");
  check("heal 1/3 scheduled", /self-heal 1\/3/.test(v1.lastDecision));

  // Simulate the healed run failing again (operator start resets the budget, so
  // drive the internal path: status must be error and start() called as auto).
  sup.start(a.id, { auto: true }); // fires launch immediately (slot free)
  await tick();
  const v2 = sup.list().find((s) => s.id === a.id)!;
  check("second failure → heal 2/3", /self-heal 2\/3/.test(v2.lastDecision));

  sup.start(a.id, { auto: true });
  await tick();
  sup.start(a.id, { auto: true });
  await tick();
  const v4 = sup.list().find((s) => s.id === a.id)!;
  check("budget exhausted → no 4th heal", !/self-heal 4/.test(v4.lastDecision));
  sup.shutdown?.();
}

// --- manual start refills the budget -----------------------------------------
{
  const sup = new Supervisor(baseCfg(), undefined, undefined, failingRunner);
  const a = sup.addSession({ cwd: "C:\\x", goal: "g", doneCriteria: "d" });
  sup.start(a.id);
  await tick();
  sup.start(a.id); // manual (non-auto) start resets healAttempts
  await tick();
  const v = sup.list().find((s) => s.id === a.id)!;
  check("manual restart refills the heal budget (1/3 again)", /self-heal 1\/3/.test(v.lastDecision));
  sup.shutdown?.();
}

// --- autoHeal off → no heal, plain error --------------------------------------
{
  const cfg = baseCfg();
  cfg.reliability = { autoHeal: false };
  const sup = new Supervisor(cfg, undefined, undefined, failingRunner);
  const a = sup.addSession({ cwd: "C:\\x", goal: "g", doneCriteria: "d" });
  sup.start(a.id);
  await tick();
  const v = sup.list().find((s) => s.id === a.id)!;
  check("autoHeal:false → status error, no heal", v.status === "error" && !/self-heal/.test(v.lastDecision));
  sup.shutdown?.();
}

// --- auth errors never heal ----------------------------------------------------
{
  errorMessage = "claude reported an authentication error (401). Run `claude` and `/login`.";
  const sup = new Supervisor(baseCfg(), undefined, undefined, failingRunner);
  const a = sup.addSession({ cwd: "C:\\x", goal: "g", doneCriteria: "d" });
  sup.start(a.id);
  await tick();
  const v = sup.list().find((s) => s.id === a.id)!;
  check("auth error → no heal (needs the human)", v.status === "error" && !/self-heal/.test(v.lastDecision));
  errorMessage = "claude's screen was frozen for 480s and never became ready";
  sup.shutdown?.();
}

// --- an operator stop wins over a scheduled heal -------------------------------
{
  const sup = new Supervisor(baseCfg(), undefined, undefined, failingRunner);
  const a = sup.addSession({ cwd: "C:\\x", goal: "g", doneCriteria: "d" });
  sup.start(a.id);
  await tick();
  sup.stop(a.id); // cancels pending resume/heal timers
  const v = sup.list().find((s) => s.id === a.id)!;
  check("stop after heal-scheduled → session not left running", v.status !== "running");
  sup.shutdown?.();
}

console.log(`\n[autoheal] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
