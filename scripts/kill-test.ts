/**
 * Reproduce + verify the fix for the node-pty Windows teardown assertion
 * ("UV_HANDLE_CLOSING ... async.c") that fires when we kill a live ConPTY and
 * exit. Booting claude consumes no model turn, so this is free to iterate on.
 */
import { ClaudeSession } from "../src/session/claudeSession.js";

const sess = new ClaudeSession({
  id: crypto.randomUUID(),
  cwd: process.cwd(),
  goal: "",
  doneCriteria: "",
  permissionMode: "acceptEdits",
});

(async () => {
  console.log("[kill-test] booting (no turn)...");
  await sess.start();
  console.log("[kill-test] booted, disposing...");
  await sess.dispose();
  console.log("[kill-test] disposed cleanly. exiting.");
  process.exit(0);
})().catch((e) => {
  console.error("[kill-test] error:", e.message);
  process.exit(1);
});
