/**
 * Deterministic tests for workflow dependencies + fleet controls (no real claude,
 * no model). A stub runner with per-session deferred promises lets us drive each
 * "session" to completion on demand and assert the dependency gate, auto-promotion
 * chaining, cycle rejection, and stopAll — all synchronous-ish via microtask flush.
 */
import { Supervisor, type RunFn } from "../src/server/supervisor.js";
import type { AppConfig, SessionConfig } from "../src/types.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI";
let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const baseCfg = (sessions: SessionConfig[]): AppConfig => ({
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b" },
  limits: { maxTurns: 50, maxWallClockMin: 720, pingPongThreshold: 5, stuckTurns: 5 },
  sessions,
});

/** A supervisor whose sessions "run" until we resolve them, recording launch order. */
function harness(sessions: SessionConfig[]) {
  const resolvers = new Map<string, () => void>();
  const launchOrder: string[] = [];
  const runner: RunFn = (session) => {
    launchOrder.push(session.id);
    return new Promise<void>((resolve) => resolvers.set(session.id, resolve));
  };
  const sup = new Supervisor(baseCfg(sessions), undefined, undefined, runner);
  const finish = async (id: string) => {
    resolvers.get(id)?.();
    resolvers.delete(id);
    await tick();
    await tick();
  };
  const statusOf = (id: string) => sup.list().find((s) => s.id === id)?.status;
  return { sup, finish, statusOf, launchOrder };
}

// ── 1. dependency gate + auto-promotion chains A → B → C ─────────────────────
{
  const A: SessionConfig = { id: "A", cwd: ROOT, goal: "build core", doneCriteria: "d" };
  const B: SessionConfig = { id: "B", cwd: ROOT, goal: "build ui", doneCriteria: "d", dependsOn: ["A"] };
  const C: SessionConfig = { id: "C", cwd: ROOT, goal: "ship it", doneCriteria: "d", dependsOn: ["B"] };
  const { sup, finish, statusOf, launchOrder } = harness([A, B, C]);

  sup.startAll();
  await tick();
  check("startAll launches the root (A) immediately", statusOf("A") === "running");
  check("dependent B is blocked while A runs", statusOf("B") === "blocked");
  check("dependent C is blocked while B is blocked", statusOf("C") === "blocked");
  const bView = sup.list().find((s) => s.id === "B");
  check("blocked B reports blockedBy = [A]", JSON.stringify(bView?.blockedBy) === JSON.stringify(["A"]));
  check("blocked B exposes its dependsOn", JSON.stringify(bView?.dependsOn) === JSON.stringify(["A"]));

  await finish("A");
  check("A is done after finishing", statusOf("A") === "done");
  check("B auto-promotes to running when A finishes", statusOf("B") === "running");
  check("C stays blocked while B runs", statusOf("C") === "blocked");

  await finish("B");
  check("B done, C auto-promotes to running", statusOf("B") === "done" && statusOf("C") === "running");

  await finish("C");
  check("C reaches done — workflow complete", statusOf("C") === "done");
  check("launch order respected dependencies (A,B,C)", launchOrder.join(",") === "A,B,C");
}

// ── 2. no-regression: a session with no deps starts exactly as before ────────
{
  const S: SessionConfig = { id: "solo", cwd: ROOT, goal: "g", doneCriteria: "d" };
  const { sup, finish, statusOf } = harness([S]);
  sup.start("solo");
  await tick();
  check("dep-free session launches normally", statusOf("solo") === "running");
  await finish("solo");
  check("dep-free session finishes done", statusOf("solo") === "done");
}

// ── 3. cycle + self-dep + unknown-id sanitation on updateSession ─────────────
{
  const A: SessionConfig = { id: "A", cwd: ROOT, goal: "a", doneCriteria: "d" };
  const B: SessionConfig = { id: "B", cwd: ROOT, goal: "b", doneCriteria: "d", dependsOn: ["A"] };
  const C: SessionConfig = { id: "C", cwd: ROOT, goal: "c", doneCriteria: "d", dependsOn: ["B"] };
  const { sup } = harness([A, B, C]);

  let cycleRejected = false;
  try {
    sup.updateSession("A", { dependsOn: ["C"] }); // A→C, but C→B→A already ⇒ cycle
  } catch {
    cycleRejected = true;
  }
  check("updateSession rejects a dependency cycle", cycleRejected);
  check("rejected cycle leaves A's deps untouched", sup.list().find((s) => s.id === "A")?.dependsOn === undefined);

  sup.updateSession("A", { dependsOn: ["A"] }); // self-dependency
  check("self-dependency is dropped (not stored)", sup.list().find((s) => s.id === "A")?.dependsOn === undefined);

  sup.updateSession("A", { dependsOn: ["does-not-exist"] }); // unknown id
  check("unknown dependency id is dropped", sup.list().find((s) => s.id === "A")?.dependsOn === undefined);

  sup.updateSession("C", { dependsOn: [] }); // clear deps
  check("clearing deps removes the field", sup.list().find((s) => s.id === "C")?.dependsOn === undefined);
}

// ── 4. editing deps releases a blocked session ───────────────────────────────
{
  const A: SessionConfig = { id: "A", cwd: ROOT, goal: "a", doneCriteria: "d" };
  const B: SessionConfig = { id: "B", cwd: ROOT, goal: "b", doneCriteria: "d", dependsOn: ["A"] };
  const { sup, statusOf } = harness([A, B]);
  sup.start("B"); // A never started ⇒ B blocks on it
  await tick();
  check("B blocks when its dependency hasn't run", statusOf("B") === "blocked");
  sup.updateSession("B", { dependsOn: [] }); // drop the dependency
  check("dropping the dependency clears the block (back to idle)", statusOf("B") === "idle");
}

// ── 5. stopAll clears blocked + queued sessions ──────────────────────────────
// (Tearing down a RUNNING session needs the real pty/event stream, so the stub
// can't observe that transition — we assert the new blocked/queued paths + that
// stopAll runs cleanly over a running session.)
{
  const A: SessionConfig = { id: "A", cwd: ROOT, goal: "a", doneCriteria: "d" };
  const B: SessionConfig = { id: "B", cwd: ROOT, goal: "b", doneCriteria: "d" };
  const C: SessionConfig = { id: "C", cwd: ROOT, goal: "c", doneCriteria: "d", dependsOn: ["A"] };
  // maxConcurrent 1 ⇒ A runs, B queues, C blocks on A.
  const resolvers = new Map<string, () => void>();
  const runner: RunFn = (s) => new Promise<void>((r) => resolvers.set(s.id, r));
  const sup = new Supervisor({ ...baseCfg([A, B, C]), maxConcurrent: 1 }, undefined, undefined, runner);
  const statusOf = (id: string) => sup.list().find((s) => s.id === id)?.status;

  sup.startAll();
  await tick();
  check("pre-stop: A running, B queued, C blocked", statusOf("A") === "running" && statusOf("B") === "queued" && statusOf("C") === "blocked");
  sup.stopAll();
  await tick();
  check("stopAll clears the queued session back to idle", statusOf("B") === "idle");
  check("stopAll clears the blocked session back to idle", statusOf("C") === "idle");
}

console.log(`\n[workflow] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
