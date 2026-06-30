/**
 * One-command launch: build the dashboard UI, then start the dashboard server
 * with the browser auto-opening once it's listening. Used by `npm start` /
 * `npm run launch` and the desktop shortcut.
 *
 * Before starting, it reclaims the port from a *previous AGI dashboard* if one
 * is still running (the common "I relaunched but the old stale server is still
 * serving the page" trap). It only ever stops a process whose command line is
 * OUR server (src/server/index.ts) — never claude.exe or anything unrelated.
 */
import { spawn, spawnSync, execSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const PORT = Number(process.env.AGI_PORT) || 4317;

/** PIDs currently LISTENING on `port` (best-effort, cross-platform). */
function listenersOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && Number(m[1]) === port) pids.add(m[2]);
      }
      return [...pids];
    }
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return []; // nothing listening, or the probe tool is unavailable
  }
}

/** The full command line for a pid, so we can confirm it's our server. */
function commandLineOf(pid) {
  try {
    if (process.platform === "win32") {
      return execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: "utf8" },
      );
    }
    return execSync(`ps -o command= -p ${pid}`, { encoding: "utf8" });
  } catch {
    return "";
  }
}

function stop(pid) {
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    else execSync(`kill ${pid}`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

/** If a stale AGI dashboard is holding the port, stop it (and only it). */
function reclaimPort(port) {
  for (const pid of listenersOnPort(port)) {
    const cmd = commandLineOf(pid);
    const isOurServer = /src[\\/]server[\\/]index\.ts/.test(cmd);
    const isClaude = /claude(\.exe)?\b/i.test(cmd);
    if (isOurServer && !isClaude) {
      console.log(`▸ Port ${port} held by a previous dashboard (pid ${pid}) — stopping it…`);
      stop(pid);
    } else {
      console.warn(
        `⚠ Port ${port} is held by pid ${pid}, which is NOT the AGI dashboard — leaving it alone.\n` +
          `  Free the port or set AGI_PORT to a different value, then retry.`,
      );
    }
  }
}

reclaimPort(PORT);

// shell:true is required on Windows: Node ≥20 refuses to spawn `npm.cmd`
// directly (a .cmd batch-file security fix), failing with EINVAL otherwise.
// Pass the whole command as one string (not args[]) to avoid the DEP0190
// shell-args warning — these commands are static, with no interpolation.
console.log("▸ Building the dashboard UI…");
const build = spawnSync(`${npm} run web:build`, { stdio: "inherit", shell: true });
if (build.error) {
  console.error(`\n✖ Could not run the build: ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  console.error("\n✖ UI build failed — fix the error above and try again.");
  process.exit(build.status ?? 1);
}

console.log("\n▸ Starting the AGI dashboard…");
// AGI_OPEN=1 tells the server to open the browser once it's listening.
const server = spawn(`${npm} run dashboard`, {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, AGI_OPEN: "1" },
});
server.on("exit", (code) => process.exit(code ?? 0));
// Forward Ctrl+C cleanly to the server so it can shut sessions down.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.kill(sig));
}
