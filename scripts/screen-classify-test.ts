/**
 * Deterministic test for classifyScreen — the MAIN-session-vs-subagent fix.
 *
 * The key regression: when the main session is idle but background agents are
 * still running, the TUI shows the idle input box AND background "esc to
 * interrupt" / "↓ N tokens" status. That must classify as READY (the main
 * session is what we drive), not WORKING — otherwise the orchestrator stalls.
 */
import { classifyScreen } from "../src/terminal/state.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

// The reported bug: main idle box + background-agent activity on screen.
const idleWithBgAgents = `
● Agent 1 building HUB shell… (22s · ↓ 765 tokens)
  └ Next: Merge Agent 1 (HUB shell) into master

────────────────────────────────────────────────
>
────────────────────────────────────────────────
  ▶▶ auto mode on (shift+tab to cycle) · esc to interrupt · ctrl+t to show tasks · ← for agents
`;
check("idle box + background agents => ready (not working)", classifyScreen(idleWithBgAgents) === "ready");

// Classic idle box (no agents).
check("plain idle box => ready", classifyScreen("user@x\n> \n  ? for shortcuts") === "ready");

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
