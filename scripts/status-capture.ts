/**
 * Diagnostic (throwaway): boot a fresh claude, run `/status` (and `/usage` if it
 * exists), and dump the exact screen text so we can see how Claude Code reports
 * its REAL limits (session / weekly / Opus-vs-Sonnet) and reset times. A fresh
 * session + local slash commands burn no model usage. Kills its own session.
 */
import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { VirtualScreen } from "../src/terminal/screen.js";
import { classifyScreen } from "../src/terminal/state.js";
import { scrubbedEnv } from "../src/util/env.js";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\status-cap";
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

async function runCmd(cmd: string, label: string) {
  term.write(cmd);
  await sleep(700);
  term.write("\r");
  await sleep(3500);
  console.log(`\n===== ${label} (${cmd}) =====`);
  console.log(screen.visibleText());
  term.write("\x1b"); // close any panel
  await sleep(1200);
}

(async () => {
  await sleep(7000);
  await clearBootGates();
  await sleep(1500);
  await runCmd("/usage", "USAGE");
  term.kill();
})().catch((e) => {
  console.error("capture error:", e);
  term.kill();
});
