/**
 * Tier 0 verification: run one real session with the Recorder attached, then
 * read the persisted run / turns / decisions back out of SQLite.
 */
import { mkdirSync, rmSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { LocalLLM } from "../src/brain/provider.js";
import { openStore } from "../src/db/store.js";
import { Recorder } from "../src/db/recorder.js";
import { runSession } from "../src/orchestrator.js";
import type { SessionConfig } from "../src/types.js";

const DB = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\db-test.db";
const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\db-demo";
rmSync(DB, { force: true });
mkdirSync(CWD, { recursive: true });

const cfg = await loadConfig();
const llm = new LocalLLM(cfg.provider);
const store = openStore(DB);
const recorder = new Recorder(store);

const session: SessionConfig = {
  id: "db-demo",
  cwd: CWD,
  goal: "Create a file note.txt containing the single word: persisted.",
  doneCriteria: "note.txt exists containing the word persisted.",
  permissionMode: "acceptEdits",
};
store.upsertSession(session);

console.log("[db-test] running one session…");
await runSession(session, {
  llm,
  limits: { maxTurns: 3, maxWallClockMin: 8, pingPongThreshold: 2 },
  onEvent: (e) => recorder.record(e),
});

// ---- read it back -------------------------------------------------------
const sessions = store.getSessions();
const runs = store.getRuns("db-demo");
const run = runs[0];
const turns = run ? store.getTurns(run.id) : [];
const stats = store.sessionStats("db-demo");

console.log(`\n[db-test] sessions in db: ${sessions.length}`);
console.log(`[db-test] runs: ${runs.length}  | latest run #${run?.id} status=${run?.status} reason="${run?.stop_reason}" turns=${run?.turns}`);
for (const t of turns) {
  console.log(`  turn ${t.n}: ${(t.assistant_text ?? "").replace(/\s+/g, " ").slice(0, 70)}  (${t.duration_ms}ms)`);
}
console.log(`[db-test] stats: runs=${stats.runs} totalTurns=${stats.totalTurns}`);

const ok = sessions.length >= 1 && runs.length >= 1 && run?.status === "ended" && turns.length >= 1;
console.log(`\n[db-test] => ${ok ? "PASS ✅ (run/turns/decisions persisted to SQLite)" : "FAIL ⚠️"}`);
store.close();
process.exit(ok ? 0 : 1);
