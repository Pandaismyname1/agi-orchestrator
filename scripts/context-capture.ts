/**
 * Diagnostic (throwaway): boot a fresh claude, run `/context`, and dump the exact
 * screen so we can see how Claude Code reports REAL context-window usage (vs our
 * broken transcript-byte estimate). Also dumps the idle screen to check for a
 * persistent on-screen context indicator. Burns no model usage. Kills its session.
 */
import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { VirtualScreen } from "../src/terminal/screen.js";
import { classifyScreen } from "../src/terminal/state.js";
import { scrubbedEnv } from "../src/util/env.js";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\context-cap";
mkdirSync(CWD, { recursive: true });

const screen = new VirtualScreen(120, 74);
const term = pty.spawn("claude.exe", ["--session-id", randomUUID(), "--permission-mode", "default"], {
  name: "xterm-256color", cols: 120, rows: 74, cwd: CWD, env: scrubbedEnv(), useConptyDll: true,
});
term.onData((d) => screen.write(d));
term.onExit(() => process.exit(0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clearBootGates() {
  for (let i = 0; i < 5; i++) {
    const t = screen.visibleText();
    if (/trust this folder|Use this and all future MCP|Enter to confirm/i.test(t) && classifyScreen(t) === "gate") {
      term.write("\r");
      await sleep(2500);
    } else break;
  }
}

(async () => {
  await sleep(7000);
  await clearBootGates();
  await sleep(1000);
  console.log("===== IDLE SCREEN (look for a persistent context indicator) =====");
  console.log(screen.visibleText());
  term.write("/context");
  await sleep(700);
  term.write("\r");
  await sleep(3500);
  console.log("\n===== /context (full, 74 rows + scrollback) =====");
  console.log(screen.fullText(120));
  term.write("\x1b");
  await sleep(800);
  term.kill();
})().catch((e) => {
  console.error("capture error:", e);
  term.kill();
});
