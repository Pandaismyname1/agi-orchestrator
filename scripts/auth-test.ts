/**
 * Test the 401 hypothesis: is the auth failure just an artifact of spawning
 * claude from INSIDE a Claude Code session (which holds the live OAuth token
 * in-process)? If we scrub the inherited CLAUDE_CODE_* / CLAUDECODE vars and
 * spawn with a clean env, claude should fall back to the user's normal cached
 * credentials and authenticate.
 *
 * Probe: "6 x 7" -> expect "42". Also flags "401" / "Invalid authentication".
 */
import * as pty from "node-pty";
import { VirtualScreen } from "../src/terminal/screen.js";

/** Build a clean environment: drop everything the parent Claude session injected. */
function scrubbedEnv(): Record<string, string> {
  const drop = (k: string) =>
    /^CLAUDE(CODE)?($|_)/i.test(k) ||
    k === "AI_AGENT" ||
    k === "BAGGAGE" ||
    k === "API_TIMEOUT_MS" ||
    k === "ANTHROPIC_API_KEY" || // never let an API key sneak in (billing trap)
    k === "ANTHROPIC_BASE_URL";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null && !drop(k)) out[k] = v;
  }
  return out;
}

const env = scrubbedEnv();
console.log(`[auth-test] scrubbed ${Object.keys(process.env).length - Object.keys(env).length} env vars`);
console.log(`[auth-test] CLAUDE* remaining: ${Object.keys(env).filter((k) => /claude/i.test(k)).join(", ") || "(none)"}`);

const screen = new VirtualScreen(100, 30);
const term = pty.spawn("claude.exe", [], {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd: process.cwd(),
  env,
  useConptyDll: true,
});

term.onData((d) => screen.write(d));
term.onExit(() => process.exit(0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(6000);
  for (let i = 0; i < 4; i++) {
    if (/Enter to confirm|❯\s*1\./.test(screen.visibleText())) {
      term.write("\r");
      await sleep(2000);
    } else break;
  }

  console.log("[auth-test] injecting probe...");
  term.write("What is 6 multiplied by 7? Reply with only the number.");
  await sleep(1200);
  term.write("\r");

  // poll up to 20s for an answer or an auth error
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const t = screen.fullText();
    if (/401|Invalid authentication|Please run \/login/i.test(t)) {
      console.log("[auth-test] ❌ STILL 401 — auth not fixed by env scrub");
      break;
    }
    if (/\b42\b/.test(t)) {
      console.log("[auth-test] ✅ AUTHENTICATED — got 42 from subscription");
      break;
    }
  }

  console.log("---- final screen ----");
  console.log(screen.visibleText());
  term.kill();
})();
