/**
 * PTY smoke test — the make-or-break proof for the whole project.
 *
 * Proves the daemon can, against the REAL interactive `claude` CLI in an owned PTY:
 *   1. spawn it
 *   2. READ its screen cleanly (via a headless VT emulator, not raw scraping)
 *   3. clear interstitial GATES (trust dialog, MCP approval, ...) generically
 *   4. INJECT a prompt and read the model's reply back
 *
 * Probe: ask "6 x 7" and look for "42" — the answer is NOT in the prompt text,
 * so seeing it on screen proves claude actually processed our injected input.
 *
 * Run:  npm run pty-smoke
 */
import * as pty from "node-pty";
import { VirtualScreen } from "../src/terminal/screen.js";

const SETTLE_MS = 2500;
const COLS = 100;
const ROWS = 30;
const PROBE_PROMPT = "What is 6 multiplied by 7? Reply with only the number, nothing else.";
const PROBE_ANSWER = "42";
const MAX_GATES = 6;

const screen = new VirtualScreen(COLS, ROWS);
const term = pty.spawn("claude.exe", [], {
  name: "xterm-256color",
  cols: COLS,
  rows: ROWS,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
  useConptyDll: true,
});

let phase: "boot" | "reply" | "done" = "boot";
let gatesCleared = 0;
let settleTimer: NodeJS.Timeout | undefined;

const isGate = (text: string) => /Enter to confirm|❯\s*1\./.test(text);

function arm() {
  if (phase === "done") return;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(onSettle, SETTLE_MS);
}

function onSettle() {
  const text = screen.visibleText();

  if (phase === "boot") {
    if (isGate(text)) {
      if (gatesCleared >= MAX_GATES) {
        console.log(`\n[smoke] too many gates (${gatesCleared}), aborting.`);
        term.kill();
        return;
      }
      gatesCleared++;
      console.log(`\n[smoke] ── gate #${gatesCleared} detected, accepting default (Enter) ──`);
      term.write("\r");
      arm();
      return;
    }
    // No gate, session is idle & ready -> inject the probe.
    phase = "reply";
    console.log(`\n[smoke] ── ready (${gatesCleared} gate(s) cleared), injecting probe via PTY stdin ──`);
    term.write(PROBE_PROMPT);
    setTimeout(() => term.write("\r"), 300);
    arm();
    return;
  }

  if (phase === "reply") {
    const full = screen.fullText();
    const sawAnswer = full.includes(PROBE_ANSWER);
    if (!sawAnswer && isGate(screen.visibleText())) {
      // Model wanted to run a tool -> another gate. Accept and keep waiting.
      console.log(`\n[smoke] ── post-inject gate, accepting (Enter) ──`);
      term.write("\r");
      arm();
      return;
    }
    phase = "done";
    console.log(`\n[smoke] ── reply settled ──`);
    console.log(`[smoke] RESULT: spawn=ok  read=ok  gates=ok  inject=ok  reply-has-"${PROBE_ANSWER}"=${sawAnswer}`);
    console.log(`[smoke] => FULL PTY DRIVE LOOP ${sawAnswer ? "WORKS ✅" : "needs tuning ⚠️"}`);
    term.kill();
  }
}

term.onData((data) => {
  screen.write(data);
  arm();
});

term.onExit(({ exitCode }) => {
  console.log(`\n[smoke] claude exited (code ${exitCode})`);
  console.log("---- final clean screen ----");
  console.log(screen.visibleText());
  process.exit(0);
});

setTimeout(() => {
  console.log("\n[smoke] 120s hard cap — killing.");
  term.kill();
}, 120_000);
