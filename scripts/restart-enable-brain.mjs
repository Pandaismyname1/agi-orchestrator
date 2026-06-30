/**
 * ONE-SHOT: bring the smarter-brain wins live on the running orchestrator.
 *
 * Why this exists: the live `config.json` has no `brain` block yet, and the
 * RUNNING (old-code) server periodically rewrites config.json — so editing it
 * while that server is up gets clobbered. This script does the only safe order:
 *   1. stop OUR dashboard server (matched strictly by its `src/server/index.ts`
 *      command line — never claude.exe directly), which also frees its child
 *      claude sessions; they all auto-resume from their saved IDs under the new
 *      server,
 *   2. THEN patch config.json to enable rolling summary (old server is dead, so
 *      nothing overwrites it),
 *   3. THEN `npm start` (rebuild UI + launch), which loads the new brain code
 *      (REPO STATE is always-on; rolling summary now enabled).
 *
 * RUN IT FROM A SEPARATE, INDEPENDENT TERMINAL — NOT from inside a dashboard
 * session. Stopping the server kills its child claude.exe sessions; if you run
 * this from within one of them it would kill itself mid-restart. The script
 * refuses to run if it detects it's a descendant of the server it would stop.
 *
 *   node scripts/restart-enable-brain.mjs        (or: npm run restart-brain)
 */
import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "config.json");
const isWin = process.platform === "win32";

/** Command line of a pid (Windows via CIM, *nix via ps). "" if unknown. */
function cmdlineOf(pid) {
  try {
    if (isWin) {
      return execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: "utf8" },
      ).trim();
    }
    return execSync(`ps -o command= -p ${pid}`, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Parent pid of a pid (best-effort). 0/undefined if unknown. */
function parentOf(pid) {
  try {
    if (isWin) {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`,
        { encoding: "utf8" },
      ).trim();
      return Number(out) || 0;
    }
    const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8" }).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

const isOurServer = (cmd) => /src[\\/]server[\\/]index\.ts/.test(cmd);
const isClaude = (cmd) => /claude(\.exe)?\b/i.test(cmd);

/** All PIDs whose command line is OUR dashboard server (and not claude). */
function findServerPids() {
  const pids = new Set();
  try {
    if (isWin) {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"`,
        { encoding: "utf8" },
      );
      for (const line of out.split(/\r?\n/)) {
        const [pid, ...rest] = line.split("|");
        const cmd = rest.join("|");
        if (pid && isOurServer(cmd) && !isClaude(cmd)) pids.add(Number(pid));
      }
    } else {
      const out = execSync(`ps -eo pid=,command=`, { encoding: "utf8" });
      for (const line of out.split(/\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m && isOurServer(m[2]) && !isClaude(m[2])) pids.add(Number(m[1]));
      }
    }
  } catch (e) {
    console.error(`Could not enumerate processes: ${e.message}`);
  }
  return [...pids];
}

/** True if `me` is a descendant of any pid in `targets` (walks the parent chain). */
function isDescendantOf(me, targets) {
  const set = new Set(targets);
  let pid = me;
  for (let i = 0; i < 16 && pid > 0; i++) {
    pid = parentOf(pid);
    if (set.has(pid)) return true;
  }
  return false;
}

// ── 1. locate the server ─────────────────────────────────────────────────────
const serverPids = findServerPids();
if (serverPids.length === 0) {
  console.log("No running AGI dashboard server found. Just enabling the config and starting fresh.");
} else {
  console.log(`Found AGI dashboard server pid(s): ${serverPids.join(", ")}`);

  // ── safety: never let this script kill its own ancestor (self-destruct) ─────
  if (isDescendantOf(process.pid, serverPids)) {
    console.error(
      "\n✖ REFUSING TO RUN: this process is a CHILD of the server it would stop.\n" +
        "  You're running this from inside a dashboard-driven session. Killing the\n" +
        "  server here would terminate this very process mid-restart and could leave\n" +
        "  NO server running. Open a SEPARATE, normal terminal (outside the orchestrator)\n" +
        "  and run this script there.",
    );
    process.exit(2);
  }

  // ── 2. stop the server (its child claude sessions resume under the new one) ──
  for (const pid of serverPids) {
    try {
      if (isWin) execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
      else execSync(`kill ${pid}`, { stdio: "ignore" });
      console.log(`  stopped server pid ${pid} (and its session subtree)`);
    } catch {
      /* already gone */
    }
  }
  // brief settle so the old process fully releases config.json + the port
  execSync(isWin ? "powershell -NoProfile -Command \"Start-Sleep -Milliseconds 1500\"" : "sleep 1.5");
}

// ── 3. patch config.json (old server is dead → no overwrite race) ─────────────
let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
} catch (e) {
  console.error(`\n✖ Could not read/parse config.json: ${e.message}`);
  process.exit(1);
}
cfg.brain = cfg.brain && typeof cfg.brain === "object" ? cfg.brain : {};
if (typeof cfg.brain.confidenceThreshold !== "number") cfg.brain.confidenceThreshold = 0; // gate off (low live value)
cfg.brain.rollingSummary = {
  everyTurns: 4,
  maxChars: 1200,
  tailMessages: 3,
  ...(cfg.brain.rollingSummary && typeof cfg.brain.rollingSummary === "object" ? cfg.brain.rollingSummary : {}),
  enabled: true,
};
const tmp = CONFIG + ".tmp";
writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
renameSync(tmp, CONFIG); // atomic replace
console.log("  config.json: brain.rollingSummary.enabled = true (REPO STATE is always-on)");

// ── 4. start the new server (build + dashboard) ───────────────────────────────
console.log("\n▸ Launching the new dashboard (npm start)… sessions will resume under the new code.\n");
const npm = isWin ? "npm.cmd" : "npm";
const child = spawn(`${npm} start`, { cwd: ROOT, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
