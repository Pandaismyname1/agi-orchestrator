/**
 * Deterministic test for decision-feedback (learning-loop thumbs up/down):
 * the store's setLatestDecisionFeedback / setDecisionFeedback / feedbackStats,
 * the feedback column on getDecisions, and per-session scoping. No LLM, no claude.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db/store.js";

const dir = mkdtempSync(join(tmpdir(), "agi-feedback-"));
const DB = join(dir, "feedback-test.db");
const store = openStore(DB);

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// --- seed: session A with one run of 3 decisions ----------------------------
store.upsertSession({ id: "A", cwd: "x", goal: "g", doneCriteria: "d" });
const rA = store.startRun("A");
for (let n = 1; n <= 3; n++) {
  const tid = store.addTurn(rA, { n, prompt: `step ${n}`, assistantText: `did ${n}`, durationMs: 10, gatesHandled: 0 });
  store.addDecision(tid, { action: n === 3 ? "stop" : "continue", prompt: `step ${n + 1}`, reason: "r" });
}

// --- baseline: nothing rated -------------------------------------------------
check("stats start at 0/0", store.feedbackStats("A").up === 0 && store.feedbackStats("A").down === 0);
check("getDecisions feedback is null before rating", store.getDecisions(rA).every((d) => d.feedback === null));

// --- setLatestDecisionFeedback targets the most recent decision (turn 3) -----
const rated = store.setLatestDecisionFeedback("A", "up");
check("setLatestDecisionFeedback returns the rated run+turn", rated?.runId === rA && rated?.turnN === 3);
let dec = store.getDecisions(rA);
check("turn 3 decision is now 'up'", dec.find((d) => d.n === 3)?.feedback === "up");
check("turns 1 & 2 stay unrated", dec.find((d) => d.n === 1)?.feedback === null && dec.find((d) => d.n === 2)?.feedback === null);
check("stats now up=1 down=0", store.feedbackStats("A").up === 1 && store.feedbackStats("A").down === 0);

// --- clearing (null) removes the rating -------------------------------------
store.setLatestDecisionFeedback("A", null);
check("clearing resets the latest decision", store.getDecisions(rA).find((d) => d.n === 3)?.feedback === null);
check("stats back to 0/0 after clear", store.feedbackStats("A").up === 0 && store.feedbackStats("A").down === 0);

// --- setDecisionFeedback by run+turn (history timeline path) -----------------
check("rate turn 1 up (correct session) succeeds", store.setDecisionFeedback("A", rA, 1, "up"));
check("rate turn 2 down succeeds", store.setDecisionFeedback("A", rA, 2, "down"));
dec = store.getDecisions(rA);
check("turn 1 is up, turn 2 is down", dec.find((d) => d.n === 1)?.feedback === "up" && dec.find((d) => d.n === 2)?.feedback === "down");
check("stats reflect up=1 down=1", store.feedbackStats("A").up === 1 && store.feedbackStats("A").down === 1);

// --- per-session scoping: can't rate run rA as a different session -----------
check("wrong-session rating is rejected", !store.setDecisionFeedback("WRONG", rA, 1, "down"));
check("turn 1 feedback unchanged after rejected write", store.getDecisions(rA).find((d) => d.n === 1)?.feedback === "up");

// --- a missing turn returns false (no row updated) ---------------------------
check("rating a nonexistent turn returns false", !store.setDecisionFeedback("A", rA, 99, "up"));

// --- a session with no decisions can't be rated ------------------------------
store.upsertSession({ id: "EMPTY", cwd: "x", goal: "g", doneCriteria: "d" });
check("setLatestDecisionFeedback on a decisionless session returns null", store.setLatestDecisionFeedback("EMPTY", "up") === null);

// --- global stats span sessions ---------------------------------------------
const rB = store.startRun("A");
const tB = store.addTurn(rB, { n: 1, prompt: "go", assistantText: "ok", durationMs: 10, gatesHandled: 0 });
store.addDecision(tB, { action: "continue", prompt: "next", reason: "r" });
store.setDecisionFeedback("A", rB, 1, "up");
check("session A stats now up=2 down=1 (across 2 runs)", store.feedbackStats("A").up === 2 && store.feedbackStats("A").down === 1);
check("global stats (no arg) up=2 down=1", store.feedbackStats().up === 2 && store.feedbackStats().down === 1);

store.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n[feedback] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
