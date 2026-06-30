/**
 * Deterministic tests for system health/diagnostics. The roll-up logic
 * (buildHealth) is pure and fully covered; Supervisor.health() gets a light
 * structural check (its brain probe hits a dead localhost → ok:false, which is
 * itself a valid "down" signal).
 */
import { buildHealth, type HealthInput } from "../src/server/health.js";
import { Supervisor } from "../src/server/supervisor.js";
import type { AppConfig } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const baseInput = (over: Partial<HealthInput> = {}): HealthInput => ({
  now: 100_000,
  bootAt: 40_000,
  version: "1.2.3",
  llm: { ok: true, detail: "ready", model: "qwen3.5:9b", baseUrl: "http://localhost:11434/v1" },
  db: { path: "agi.db", sizeBytes: 4096, sessions: 3, runs: 12 },
  fleet: { total: 3, running: 1, needsInput: 0, error: 0 },
  ...over,
});

// ── status roll-up ───────────────────────────────────────────────────────────
check("healthy → ok", buildHealth(baseInput()).status === "ok");
check("brain unreachable → down (critical)", buildHealth(baseInput({ llm: { ok: false, detail: "refused", model: "m", baseUrl: "u" } })).status === "down");
check("errored session → degraded", buildHealth(baseInput({ fleet: { total: 3, running: 0, needsInput: 0, error: 1 } })).status === "degraded");
check("brain-down beats errored sessions (worst-of)", buildHealth(baseInput({ llm: { ok: false, detail: "x", model: "m", baseUrl: "u" }, fleet: { total: 1, running: 0, needsInput: 0, error: 1 } })).status === "down");

// ── derived fields ───────────────────────────────────────────────────────────
const r = buildHealth(baseInput());
check("uptime = (now - bootAt) / 1000", r.uptimeSec === 60);
check("uptime never negative on clock skew", buildHealth(baseInput({ now: 0, bootAt: 5000 })).uptimeSec === 0);
check("version passed through", r.version === "1.2.3");
check("checkedAt == now", r.checkedAt === 100_000);
check("llm/db/fleet carried verbatim", r.llm.model === "qwen3.5:9b" && r.db.runs === 12 && r.fleet.running === 1);

// ── Supervisor.health() structural check ─────────────────────────────────────
const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "local", temperature: 0.3 },
  limits: { maxTurns: 5, maxWallClockMin: 10, pingPongThreshold: 3, stuckTurns: 4 },
  sessions: [{ id: "s1", cwd: "C:\\tmp\\h", goal: "g", doneCriteria: "d" }],
};
const sup = new Supervisor(cfg, undefined, undefined, () => new Promise<void>(() => {}));
const report = await sup.health();
check("supervisor health reports the fleet size", report.fleet.total === 1);
check("supervisor health carries provider model + baseUrl", report.llm.model === "qwen3.5:9b" && report.llm.baseUrl === "http://localhost:11434/v1");
check("supervisor health includes a db path", typeof report.db.path === "string" && report.db.path.length > 0);
check("supervisor health status is one of ok/degraded/down", ["ok", "degraded", "down"].includes(report.status));
check("supervisor health uptime is a non-negative number", typeof report.uptimeSec === "number" && report.uptimeSec >= 0);

console.log(`\n[health] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
