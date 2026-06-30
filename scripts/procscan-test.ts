/**
 * Deterministic test for running-claude discovery (Tier 3 #9). Feeds canned
 * `ps`/PowerShell-style output to the pure parser and the injected-runner scan —
 * no real processes. Validates session-id extraction, self/noise filtering, and
 * dedupe.
 */
import { parseProcessList, scanRunningClaude } from "../src/attach/processScan.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const SID = "a1b2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d";

const raw = [
  `  1234 node /usr/local/bin/claude --session-id ${SID} --dangerously-skip-permissions`,
  "  5678 /opt/homebrew/bin/claude --resume", // claude, no session-id
  "  9999 node /home/me/proj/agi-orchestrator/src/server/index.ts", // our own server — skip
  "  4242 /usr/bin/vim claude-notes.md", // mentions claude but isn't the CLI — skip
  "  7777 node C:\\Users\\me\\AppData\\claude\\cli.js --session-id=BADID", // claude path, bad id
  "  1234 node /usr/local/bin/claude --session-id " + SID, // duplicate pid
].join("\n");

const procs = parseProcessList(raw);

check("finds the two real claude CLIs (1234, 5678)", procs.some((p) => p.pid === 1234) && procs.some((p) => p.pid === 5678));
check("extracts the session id (space form)", procs.find((p) => p.pid === 1234)?.sessionId === SID);
check("a claude with no --session-id has none", procs.find((p) => p.pid === 5678)?.sessionId === undefined);
check("skips our own orchestrator server", !procs.some((p) => p.pid === 9999));
check("skips a non-CLI mention of 'claude'", !procs.some((p) => p.pid === 4242));
check("claude via cli.js path is detected", procs.some((p) => p.pid === 7777));
check("a malformed session id is not accepted", procs.find((p) => p.pid === 7777)?.sessionId === undefined);
check("dedupes by pid (1234 once)", procs.filter((p) => p.pid === 1234).length === 1);

// --session-id=<uuid> (equals form)
const eq = parseProcessList(`  321 claude --session-id=${SID}`);
check("extracts the session id (equals form)", eq[0]?.sessionId === SID);

// command line is capped
const long = parseProcessList(`  10 claude ` + "x".repeat(1000));
check("command line is capped", (long[0]?.commandLine.length ?? 0) <= 301 && long[0]!.commandLine.endsWith("…"));

// empty / garbage input → no throw, empty list
check("empty input → []", parseProcessList("").length === 0);
check("garbage lines ignored", parseProcessList("not a process line\n\n???").length === 0);

// scanRunningClaude with an injected runner
const scanned = await scanRunningClaude(async () => `  88 claude --session-id ${SID}`);
check("scanRunningClaude parses the injected output", scanned.length === 1 && scanned[0]?.sessionId === SID);

// a throwing runner yields [] (never throws)
const safe = await scanRunningClaude(async () => {
  throw new Error("ps failed");
});
check("a failing scan returns [] (never throws)", Array.isArray(safe) && safe.length === 0);

console.log(`\n[procscan] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
