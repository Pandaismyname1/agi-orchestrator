/**
 * Verify the adopt→resume mechanic: create a session, then RESUME it via
 * `claude --resume <id>` through our PTY and confirm it boots to ready (loads the
 * prior session) rather than erroring. Booting consumes no model turn.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { ClaudeSession } from "../src/session/claudeSession.js";
import type { SessionConfig } from "../src/types.js";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\resume-test";
rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });
const id = randomUUID();
const base: SessionConfig = { id, cwd: CWD, goal: "(t)", doneCriteria: "(t)", permissionMode: "acceptEdits" };

let pass = false;
try {
  console.log("[resume] creating a session with one turn of content…");
  const a = new ClaudeSession(base);
  await a.start();
  await a.runTurn("Remember the codeword is ORCHID. Reply with just: ok.");
  console.log(`[resume] created ${a.sessionId.slice(0, 8)} with content, disposing`);
  await a.dispose();

  console.log("[resume] resuming it via --resume…");
  const b = new ClaudeSession({ ...base, resumeId: id });
  await b.start(); // resolves only if it boots to ready (resume worked)
  console.log(`[resume] resumed session reached ready, state=${b.state()}`);
  await b.dispose();
  pass = true;
} catch (e) {
  console.log("[resume] error:", (e as Error).message);
}

rmSync(CWD, { recursive: true, force: true });
console.log(`\n[resume] => ${pass ? "PASS ✅ (claude --resume boots via PTY)" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
