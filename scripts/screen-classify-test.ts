/**
 * Deterministic test for classifyScreen — main-session readiness, agent-aware.
 *
 * The session is "ready" only when the main prompt is idle AND nothing is in
 * flight. While background agents run, the main sits at its idle box but is NOT
 * ready — prompting it just spins ("can't, agents still running"). So an idle box
 * WITH background-agent chrome must classify as WORKING (wait), and only a truly
 * idle box (no in-flight chrome) is READY.
 */
import { classifyScreen, detectChoicePrompt } from "../src/terminal/state.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

// REAL capture (Claude Code v2.1.196): main turn done, a background agent running.
// The footer is the IDLE footer (no "esc to interrupt"); the only in-flight signals
// are the "Waiting for N background agent" line and the "↑ 21.6k tokens" counter.
// This is the exact spin-loop screen — must be WORKING, not ready.
const realBgAgent = `
● Agent(Count slowly 1 to 100)
  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)
● Launched. The counting agent is running in the background — I'll be notified when it finishes.
✻ Waiting for 1 background agent to finish
  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents · ↓ to manage
  ● main
  ◯ general-purpose  Count slowly 1 to 100                                       11s · ↑ 21.6k tokens
`;
check("REAL background-agent screen => working (the spin-loop case)", classifyScreen(realBgAgent) === "working");

// The other real variant (from the owner's screenshot): footer has "esc to interrupt".
const idleWithBgAgents = `
● Agent 1 building HUB shell… (22s · ↓ 765 tokens)
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ctrl+t to show tasks · ← for agents
`;
check("idle box + background agents (esc-to-interrupt variant) => working", classifyScreen(idleWithBgAgents) === "working");

// REAL idle footer (post-boot): "? for shortcuts · ← for agents ● high · /effort". The
// "← for agents" hint persists with agents present but is NOT an in-flight signal.
check(
  "REAL idle footer (with ← for agents, nothing running) => ready",
  classifyScreen("> \n  ? for shortcuts · ← for agents ● high · /effort") === "ready",
);
check("plain idle box => ready", classifyScreen("user@x\n> \n  ? for shortcuts") === "ready");
// The "↓ to manage" footer hint (agents present) must NOT trip working on its own.
check(
  "idle footer with '↓ to manage' but no live counter => ready",
  classifyScreen("> \n  accept edits on (shift+tab to cycle) · ← for agents · ↓ to manage · ? for shortcuts") === "ready",
);

// REAL main-generation: footer "esc to interrupt" + abbreviated "↓ 2.1k tokens".
check(
  "REAL main generation (↓ 2.1k tokens) => working",
  classifyScreen("· Thundering… (45s · ↓ 2.1k tokens · esc to interrupt)") === "working",
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

// --- AskUserQuestion choice menu (the "agent stuck on options" bug) -------------
// REAL footer from the choice menu: "Enter to select · Tab/Arrow keys to navigate
// · Esc to cancel", with a "← [ ] Question  ∫ Submit →" carousel header.
const choiceMenu = `
 ← [ ] R6 scope  [ ] Finalize record  ∫ Submit  →

 How much should the v1 manifest cover?
 ❯ 1. Manifest from existing data (recommended)
   2. Manifest + per-region basis UI
   3. Defer R6
 Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;
check("AskUserQuestion choice menu => detected", detectChoicePrompt(choiceMenu) === true);
// A permission gate ("Enter to confirm") must NOT be mistaken for a choice menu —
// it stays on the gate/approval path, not the brain-answers path.
check(
  "permission gate => NOT a choice menu",
  detectChoicePrompt("Do you want to proceed?\n❯ 1. Yes\n  2. No\n Enter to confirm · Esc to cancel") ===
    false,
);
check("idle box => NOT a choice menu", detectChoicePrompt("> \n  ? for shortcuts · /effort") === false);
check("blank => NOT a choice menu", detectChoicePrompt("\n\n   \n") === false);

console.log(`\n[screen] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
