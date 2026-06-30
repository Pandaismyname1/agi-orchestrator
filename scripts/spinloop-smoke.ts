/**
 * LIVE verification of the spin-loop fix (throwaway session). Boots a real claude,
 * launches a real background agent, and checks that classifyScreen reports
 * "working" (NOT "ready") while the agent runs — i.e. the orchestrator would WAIT
 * instead of prompting the brain against unfinished work. Burns a little usage
 * (the agent does trivial work). Never touches the user's real session.
 */
import { mkdirSync } from "node:fs";
import { ClaudeSession } from "../src/session/claudeSession.js";
import { classifyScreen } from "../src/terminal/state.js";

const cwd = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\spinloop-smoke";
mkdirSync(cwd, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sess = new ClaudeSession({
  id: "spinloop-smoke",
  cwd,
  goal: "smoke",
  doneCriteria: "n/a",
  permissionMode: "default",
  gatePolicy: "auto", // auto-clear the trust gate + any tool gates so the agent launches
});

console.log("booting…");
await sess.start();
console.log(`booted; idle state = ${classifyScreen(sess.screenText())}`);

// Ask it to spawn a BACKGROUND agent and not wait — this reproduces the spin-loop
// screen (main returns to idle while the agent runs).
(sess as unknown as { type(s: string): void }).type(
  "Use a background agent (the Task tool, run_in_background) to count slowly from 1 to 60 with a short pause between numbers. Launch it in the background and immediately tell me it's running — do not wait for it.",
);
await sleep(400);
(sess as unknown as { type(s: string): void }).type("\r");

// Poll for ~50s; record states while an agent indicator is on screen.
let sawWorkingWithAgent = false;
let sawFalseReadyWithAgent = false;
for (let i = 0; i < 25; i++) {
  await sleep(2000);
  const text = sess.screenText();
  const state = classifyScreen(text);
  const agentOnScreen = /background agent|↑\s*[\d.,]+\s*[km]?\s*tokens|Waiting for \d+ background/i.test(text);
  if (agentOnScreen && state === "working") sawWorkingWithAgent = true;
  if (agentOnScreen && state === "ready") sawFalseReadyWithAgent = true;
  console.log(`  t+${(i + 1) * 2}s  state=${state}  agentOnScreen=${agentOnScreen}`);
  if (sawFalseReadyWithAgent) break;
}

console.log(`\nsaw WORKING while an agent was on screen: ${sawWorkingWithAgent}`);
console.log(`saw FALSE-READY while an agent was on screen: ${sawFalseReadyWithAgent}`);
const pass = sawWorkingWithAgent && !sawFalseReadyWithAgent;
console.log(`[spinloop-smoke] => ${pass ? "PASS ✅ (waits while agents run)" : "FAIL ⚠️"}`);

await sess.dispose();
process.exit(pass ? 0 : 1);
