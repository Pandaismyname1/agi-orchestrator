/**
 * Live smoke for the headless engine: two REAL `claude -p` turns — the second
 * must resume the first's conversation (memory carries over), proving the
 * --session-id → --resume chaining that the engine is built on. Burns two tiny
 * prompts of subscription quota — run manually, not part of `npm test`.
 */
import { HeadlessClaudeSession } from "../src/session/headlessSession.js";

const sess = new HeadlessClaudeSession({
  id: "headless-smoke",
  cwd: process.cwd(),
  goal: "smoke",
  doneCriteria: "smoke",
  permissionMode: "default",
});

const t0 = Date.now();
const step = (m: string) => console.log(`[headless-smoke +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

try {
  await sess.start();
  const sid1 = sess.sessionId;
  step(`turn 1 (session ${sid1.slice(0, 8)}…): teach it a codeword`);
  const r1 = await sess.runTurn('Remember the codeword "XYZZY-42". Reply with exactly: OK');
  step(`turn 1 done in ${(r1.durationMs / 1000).toFixed(1)}s; reply=${JSON.stringify(r1.assistantText.slice(0, 80))}`);

  step(`turn 2 (resume ${sess.sessionId.slice(0, 8)}…): recall it`);
  const r2 = await sess.runTurn("What was the codeword I told you? Reply with only the codeword.");
  step(`turn 2 done in ${(r2.durationMs / 1000).toFixed(1)}s; reply=${JSON.stringify(r2.assistantText.slice(0, 80))}`);

  const ok = /XYZZY-42/i.test(r2.assistantText) && sess.sessionId === sid1;
  step(`same conversation id across turns: ${sess.sessionId === sid1}`);
  console.log(`\n[headless-smoke] => ${ok ? "PASS ✅ (conversation memory carried across -p turns)" : "FAIL ⚠️"}`);
  await sess.dispose();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`[headless-smoke] ERROR: ${(e as Error).message}`);
  await sess.dispose();
  process.exit(1);
}
