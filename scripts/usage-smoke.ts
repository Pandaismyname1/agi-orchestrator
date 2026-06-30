/**
 * LIVE smoke test (throwaway session): spawn a real claude in a scratch dir,
 * boot it, call ClaudeSession.readUsage() and print the parsed real limits, then
 * dispose. Proves the /usage drive + parse works end-to-end against the actual
 * CLI. A fresh boot + /usage burn no model usage. Never touches a real session.
 */
import { mkdirSync } from "node:fs";
import { ClaudeSession } from "../src/session/claudeSession.js";
import { classifyScreen } from "../src/terminal/state.js";

const cwd = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\usage-smoke";
mkdirSync(cwd, { recursive: true });

const sess = new ClaudeSession({
  id: "usage-smoke",
  cwd,
  goal: "smoke test",
  doneCriteria: "n/a",
  permissionMode: "default",
  gatePolicy: "auto", // auto-clear the first-run trust gate
});

const t0 = Date.now();
console.log("booting throwaway claude…");
await sess.start();
console.log(`booted in ${((Date.now() - t0) / 1000).toFixed(1)}s; screen state = ${classifyScreen(sess.screenText())}`);

const usage = await sess.readUsage();
console.log("readUsage() =>", JSON.stringify(usage, null, 2));

const ok = !!usage && (!!usage.session || !!usage.weeklyAll);
console.log(`\n[usage-smoke] => ${ok ? "PASS ✅ (parsed real limits)" : "FAIL ⚠️ (nothing parsed)"}`);

await sess.dispose();
process.exit(ok ? 0 : 1);
