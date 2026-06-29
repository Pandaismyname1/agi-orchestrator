/**
 * Integration test for the ClaudeSession driver (everything except the brain).
 * Validates: spawn with --session-id + permission-mode, boot/gate handling,
 * turn-end detection via screen state, and reading the reply from the transcript.
 */
import { ClaudeSession } from "../src/session/claudeSession.js";
import type { SessionConfig } from "../src/types.js";

const cfg: SessionConfig = {
  id: crypto.randomUUID(),
  cwd: process.cwd(),
  goal: "(test)",
  doneCriteria: "(test)",
  permissionMode: "acceptEdits",
};

const sess = new ClaudeSession(cfg);

(async () => {
  console.log(`[session-smoke] session id ${sess.sessionId}`);
  console.log("[session-smoke] starting (boot + gate clear)...");
  await sess.start();
  console.log(`[session-smoke] booted, state=${sess.state()}`);

  console.log("[session-smoke] running turn...");
  const turn = await sess.runTurn("What is 6 multiplied by 7? Reply with only the number, nothing else.");
  console.log(`[session-smoke] turn done in ${(turn.durationMs / 1000).toFixed(1)}s, gates=${turn.gatesHandled}`);
  console.log(`[session-smoke] assistantText from transcript: "${turn.assistantText}"`);

  const pass = /\b42\b/.test(turn.assistantText);
  console.log(`[session-smoke] => ${pass ? "PASS ✅ (read reply via transcript)" : "FAIL ⚠️"}`);
  await sess.dispose();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => {
  console.error("[session-smoke] error:", e.message);
  await sess.dispose();
  process.exit(1);
});
