/**
 * LIVE wedge-check (throwaway session): drive a FULL turn that spawns a quick
 * background agent via the real ClaudeSession.runTurn(). runTurn waits for
 * "ready" — which now requires the agent to finish — so if the classifier
 * correctly transitions working→ready once the agent completes, runTurn returns;
 * if the broadened WORKING_RE wedges (token/Waiting chrome persists after the
 * agent finishes), runTurn would hang. Proves no wedge end-to-end.
 */
import { mkdirSync } from "node:fs";
import { ClaudeSession } from "../src/session/claudeSession.js";
import { classifyScreen } from "../src/terminal/state.js";

const cwd = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\agent-turn-smoke";
mkdirSync(cwd, { recursive: true });

const sess = new ClaudeSession({
  id: "agent-turn-smoke",
  cwd,
  goal: "smoke",
  doneCriteria: "n/a",
  permissionMode: "default",
  gatePolicy: "auto",
});

console.log("booting…");
await sess.start();

const t0 = Date.now();
console.log("running a turn that spawns a quick background agent…");
const result = await sess.runTurn(
  "Spawn a background agent (the Task tool with run_in_background) that just counts from 1 to 5 and then stops. Launch it in the background, then reply with a short confirmation. Do not do anything else.",
);
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const finalState = classifyScreen(sess.screenText());
console.log(`runTurn returned in ${secs}s; final screen state = ${finalState}`);
console.log("assistant text:", (result.assistantText || "").slice(0, 200).replace(/\n/g, " "));

// PASS: runTurn returned (didn't hang to the 90m cap) AND the screen settled to ready.
const pass = finalState === "ready";
console.log(`\n[agent-turn-smoke] => ${pass ? "PASS ✅ (working→ready, no wedge)" : "FAIL ⚠️ (did not settle to ready)"}`);

await sess.dispose();
process.exit(pass ? 0 : 1);
