/**
 * Deterministic test: the Supervisor routes session-lifecycle events through the
 * injected structured logger (the durable trail for unattended/overnight runs).
 *
 * A fake runner emits a couple of orchestrator events then resolves; we inject a
 * file-only Logger pointed at a temp file and assert the JSON-lines record the
 * launch, an error event, and the terminal "session ended" with the final status.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Supervisor, type RunFn } from "../src/server/supervisor.js";
import { createLogger } from "../src/util/logger.js";
import type { AppConfig } from "../src/types.js";
import type { OrchestratorEvent } from "../src/orchestrator.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const dir = mkdtempSync(path.join(tmpdir(), "agi-suplog-"));
const logFile = path.join(dir, "agi.log");

const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "local", temperature: 0.3 },
  limits: { maxTurns: 5, maxWallClockMin: 10, pingPongThreshold: 3, stuckTurns: 4 },
  sessions: [
    {
      id: "s1",
      cwd: dir,
      goal: "log lifecycle",
      doneCriteria: "done",
      permissionMode: "acceptEdits",
    },
  ],
};

// Fake runner: emit a turn + an error event, then resolve.
const runner: RunFn = async (session, opts) => {
  const emit = (e: OrchestratorEvent) => opts.onEvent?.(e);
  emit({ type: "start", sessionId: session.id, goal: session.goal } as OrchestratorEvent);
  emit({
    type: "error",
    sessionId: session.id,
    error: "boom",
  } as OrchestratorEvent);
};

const logger = createLogger({ file: logFile, console: false, level: "debug" });
const sup = new Supervisor(cfg, undefined, undefined, runner, undefined, undefined, logger);

sup.start("s1");

// The runner resolves on a microtask; give the .then() lifecycle log a tick.
await new Promise((r) => setTimeout(r, 50));

const lines = readFileSync(logFile, "utf8").trim().split(/\r?\n/).filter(Boolean);
const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

check("log file has records", recs.length >= 2);
check("logged session launch", recs.some((r) => r.msg === "session launch" && r.session === "s1"));
check("logged orchestrator error", recs.some((r) => r.msg === "orchestrator error" && r.error === "boom"));
const ended = recs.find((r) => r.msg === "session ended");
check("logged session ended", !!ended);
check("ended status is error", ended?.status === "error");
check("error-level record for the error", recs.some((r) => r.level === "error"));

rmSync(dir, { recursive: true, force: true });

console.log(`\n[supervisor-log] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
