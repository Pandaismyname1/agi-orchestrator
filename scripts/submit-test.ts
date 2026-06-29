/**
 * Isolate the SUBMIT keystroke for claude's TUI under ConPTY.
 * Types a short prompt, then tries candidate "Enter" encodings one at a time,
 * checking after each whether the input box emptied (= submitted).
 */
import * as pty from "node-pty";
import { VirtualScreen } from "../src/terminal/screen.js";

const PROMPT = "Say the single word: PONG";
const candidates: Array<{ name: string; bytes: string }> = [
  { name: "CR (\\r)", bytes: "\r" },
  { name: "LF (\\n)", bytes: "\n" },
  { name: "CRLF (\\r\\n)", bytes: "\r\n" },
];

const screen = new VirtualScreen(100, 30);
const term = pty.spawn("claude.exe", [], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
  useConptyDll: true,
});

term.onData((d) => screen.write(d));
term.onExit(() => process.exit(0));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const boxHasPrompt = () => screen.visibleText().includes("PONG") &&
  /❯[^\n]*PONG/.test(screen.visibleText());

(async () => {
  await sleep(6000); // boot

  // clear any boot gates
  for (let i = 0; i < 4; i++) {
    if (/Enter to confirm|❯\s*1\./.test(screen.visibleText())) {
      console.log(`[submit-test] clearing boot gate ${i + 1}`);
      term.write("\r");
      await sleep(2000);
    } else break;
  }

  console.log("[submit-test] typing prompt...");
  term.write(PROMPT);
  await sleep(1500);
  console.log(`[submit-test] prompt in box? ${boxHasPrompt()}`);

  for (const c of candidates) {
    if (!boxHasPrompt()) break;
    console.log(`[submit-test] trying submit: ${c.name}`);
    term.write(c.bytes);
    await sleep(2500);
    if (!boxHasPrompt()) {
      console.log(`[submit-test] ✅ SUBMIT KEY = ${c.name} (box cleared)`);
      break;
    } else {
      console.log(`[submit-test] ✗ ${c.name} did not submit`);
    }
  }

  await sleep(4000);
  console.log("---- final screen ----");
  console.log(screen.visibleText());
  term.kill();
})();
