/**
 * Deterministic test for classifyScreen — main-session readiness, agent-aware.
 *
 * The session is "ready" only when the main prompt is idle AND nothing is in
 * flight. While background agents run, the main sits at its idle box but is NOT
 * ready — prompting it just spins ("can't, agents still running"). So an idle box
 * WITH background-agent chrome must classify as WORKING (wait), and only a truly
 * idle box (no in-flight chrome) is READY.
 */
import { classifyScreen } from "../src/terminal/state.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

// The reported spin-loop: main idle box but background agents still running.
const idleWithBgAgents = `
● Agent 1 building HUB shell… (22s · ↓ 765 tokens)
  └ Next: Merge Agent 1 (HUB shell) into master

────────────────────────────────────────────────
>
────────────────────────────────────────────────
  ▶▶ auto mode on (shift+tab to cycle) · esc to interrupt · ctrl+t to show tasks · ← for agents
`;
check("idle box + background agents => working (wait, don't spin)", classifyScreen(idleWithBgAgents) === "working");

// Truly idle: main prompt, nothing running.
check("plain idle box => ready", classifyScreen("user@x\n> \n  ? for shortcuts") === "ready");
check(
  "idle box (auto-accept hint, no in-flight chrome) => ready",
  classifyScreen("> \n  auto-accept edits on (shift+tab to cycle) · ? for shortcuts") === "ready",
);

// Main session actually generating: spinner + interrupt, NO idle hint line.
const mainWorking = `
✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)

  Writing src/main/java/Hub.java
`;
check("main spinner, no idle hint => working", classifyScreen(mainWorking) === "working");

// A permission gate must win over everything.
const gate = `
 Bash(rm -rf ./legacy)
 Do you want to proceed?
 ❯ 1. Yes
   2. No, and tell Claude what to do differently
`;
check("permission gate => gate", classifyScreen(gate) === "gate");

// A gate that happens to be a selection dialog.
check(
  "selection dialog => gate",
  classifyScreen("Choose an option\n❯ 1. Foo\n  2. Bar\n Enter to confirm · Esc to cancel") === "gate",
);

// Nothing recognizable.
check("blank => unknown", classifyScreen("\n\n   \n") === "unknown");

console.log(`\n[screen] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
