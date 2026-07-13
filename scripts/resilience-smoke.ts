/**
 * Live smoke for the Phase 1/2 changes: boot a REAL claude.exe in a PTY, run one
 * trivial turn through the new bracketed-paste + verified-submit + hardened
 * classifier path, and print what happened at each step. Burns one tiny prompt
 * of subscription quota — run manually, not part of `npm test`.
 */
import { ClaudeSession } from "../src/session/claudeSession.js";

const sess = new ClaudeSession({
  id: "resilience-smoke",
  cwd: process.cwd(),
  goal: "smoke",
  doneCriteria: "smoke",
  permissionMode: "default",
});

const t0 = Date.now();
const step = (m: string) => console.log(`[smoke +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

try {
  step("booting claude…");
  await sess.start();
  step(`booted; state=${sess.state()}`);

  step("running turn: 'Reply with exactly: PONG'");
  const r = await sess.runTurn("Reply with exactly the single word: PONG");
  step(`turn done in ${(r.durationMs / 1000).toFixed(1)}s; gates=${r.gatesHandled}`);
  step(`assistant said: ${JSON.stringify(r.assistantText.slice(0, 120))}`);
  const ok = /pong/i.test(r.assistantText);
  step(`post-turn state=${sess.state()}`);
  console.log(`\n[resilience-smoke] => ${ok ? "PASS ✅" : "FAIL ⚠️ (no PONG in reply)"}`);
  await sess.dispose();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error(`[resilience-smoke] ERROR: ${(e as Error).message}`);
  await sess.dispose();
  process.exit(1);
}
