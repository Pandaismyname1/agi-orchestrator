/**
 * Bypass Permissions boot-prompt detection.
 * Verifies detectBypassWarning fires on the real startup warning and does NOT
 * trip on a normal permission gate or an AskUserQuestion choice menu (which
 * would otherwise be mishandled — Enter picks "No, exit", Esc cancels).
 */
import assert from "node:assert";
import { detectBypassWarning, classifyScreen, detectChoicePrompt } from "../src/terminal/state.js";

// The actual screen (from a live session hung at turn 0).
const BYPASS = `
WARNING: Claude Code running in Bypass Permissions mode

In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.
This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.

By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

https://code.claude.com/docs/en/security

> 1. No, exit
  2. Yes, I accept

Enter to confirm · Esc to cancel
`;

const NORMAL_GATE = `
Bash command
  rm -rf ./build

Do you want to proceed?
❯ 1. Yes
  2. No, and tell Claude what to do differently

Enter to confirm · Esc to cancel
`;

const CHOICE_MENU = `
Which approach should I take?
❯ 1. Refactor now
  2. Ship first

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

// Fires on the real warning.
assert.equal(detectBypassWarning(BYPASS), true, "should detect the bypass warning");
// Classifies as a gate (trips GATE_RE) — which is exactly why it must be intercepted first.
assert.equal(classifyScreen(BYPASS), "gate", "bypass warning trips the gate classifier");

// Does NOT fire on an ordinary permission gate or a choice menu.
assert.equal(detectBypassWarning(NORMAL_GATE), false, "must not trip on a normal gate");
assert.equal(detectBypassWarning(CHOICE_MENU), false, "must not trip on a choice menu");
// The choice menu is still caught by its own detector (unchanged).
assert.equal(detectChoicePrompt(CHOICE_MENU), true, "choice menu still detected");

console.log("✓ bypass-test: 5/5 assertions passed");
