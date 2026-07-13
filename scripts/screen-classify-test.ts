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

// --- Real frozen-screen death captures (from live agi.db, 2026-07-13) -----------
// Run 76 ("Zoom Cenzura"): turn COMPLETE, one background dev-server shell still up.
// Footer is the bypass-permissions + background-task-chips variant. The old
// classifier said "unknown" → static screen → 480s freeze → run death. Must be READY:
// background shells never exit, and the final message is already in the transcript.
const frozenDeathScreen = `
  design) and the non-code items (EU endpoint ops, legal review of draft docs).
✻ Sautéed for 18m 12s · 1 shell still running
──────────────────────────────
 > continue
──────────────────────────────
  ⏵⏵ bypass permissions on · PR #21 · 1 shell · ← for agents · ↓ to manage
`;
check("REAL death screen (turn done, 1 shell, bypass footer) => ready", classifyScreen(frozenDeathScreen) === "ready");

// Run 75 variant: completed spinner + shell, minimal footer.
check(
  "completed spinner + shell still running => ready",
  classifyScreen("  server is running on :5516 if you want to poke at it.\n✻ Worked for 24m 28s · 1 shell still running") === "ready",
);

// Completed spinner alone (no recognizable footer at all) is still turn-done.
check("bare completed spinner ('✻ Crunched for 24m 24s') => ready", classifyScreen("✻ Crunched for 24m 24s") === "ready");
check("completed spinner, hours form ('✻ Worked for 1h 3m') => ready", classifyScreen("✻ Worked for 1h 3m") === "ready");

// The bypass-permissions idle footer with no completed spinner.
check(
  "bypass-permissions idle footer => ready",
  classifyScreen("> \n  ⏵⏵ bypass permissions on · ? for shortcuts") === "ready",
);

// Guard: the completed-spinner pattern must NOT swallow the in-flight markers.
check(
  "'✻ Waiting for 1 background agent to finish' stays working",
  classifyScreen("✻ Waiting for 1 background agent to finish") === "working",
);
check(
  "completed spinner + esc-to-interrupt (still generating) stays working",
  classifyScreen("✻ Reticulating… (3m 3s · ↓ 2.1k tokens · esc to interrupt)") === "working",
);
// In-flight spinner format "(12s · …)" must not read as turn-done.
check("in-flight spinner '(12s · ↑ 1.2k tokens)' => working (token counter)", classifyScreen("✻ Cogitating… (12s · ↑ 1.2k tokens)") === "working");

console.log(`\n[screen] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
