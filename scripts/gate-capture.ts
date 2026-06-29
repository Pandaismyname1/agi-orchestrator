/**
 * Diagnostic: capture the EXACT screen text of a Bash permission prompt so we can
 * see why classifyGate didn't flag `rm -rf`. Never approves — denies with Esc, so
 * nothing is deleted.
 */
import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { VirtualScreen } from "../src/terminal/screen.js";
import { classifyScreen } from "../src/terminal/state.js";
import { classifyGate } from "../src/terminal/gates.js";
import { scrubbedEnv } from "../src/util/env.js";

const JUNK = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\gate-cap";
rmSync(JUNK, { recursive: true, force: true });
mkdirSync(JUNK, { recursive: true });
writeFileSync(`${JUNK}\\keep.txt`, "x");

const screen = new VirtualScreen(120, 40);
const term = pty.spawn("claude.exe", ["--session-id", randomUUID(), "--permission-mode", "default"], {
  name: "xterm-256color", cols: 120, rows: 40,
  cwd: "C:\\Users\\panda\\Desktop\\AGI\\.scratch",
  env: scrubbedEnv(), useConptyDll: true,
});
term.onData((d) => screen.write(d));
term.onExit(() => process.exit(0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(6000);
  // clear boot gates (trust / mcp) by Enter
  for (let i = 0; i < 4; i++) {
    const t = screen.visibleText();
    if (/trust this folder|Use this and all future MCP|Enter to confirm/i.test(t) && classifyScreen(t) === "gate") {
      term.write("\r"); await sleep(2500);
    } else break;
  }
  console.log("[capture] injecting rm goal…");
  term.write("Run exactly this shell command and nothing else: rm -rf gate-cap");
  await sleep(800); term.write("\r");

  // wait for a permission prompt
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const t = screen.visibleText();
    if (classifyScreen(t) === "gate" && /proceed|❯\s*1\./i.test(t)) {
      console.log("\n===== GATE SCREEN (clean) =====");
      console.log(t);
      console.log("===== classifyGate =====");
      console.log(JSON.stringify(classifyGate(t), null, 2));
      term.write("\x1b"); // ESC = deny, nothing deleted
      await sleep(1500);
      break;
    }
  }
  rmSync(JUNK, { recursive: true, force: true });
  term.kill();
})();
