/**
 * Discover `claude` sessions running on this machine so the dashboard can offer
 * one-click attach (Tier 3 #9). We scan the OS process list, keep processes whose
 * command line looks like Claude Code, and pull the `--session-id <uuid>` they
 * were started with — the exact id the Stop-hook attach flow needs to register.
 *
 * The OS command is INJECTED (a `ProcRunner`) and the parse is a pure function,
 * so the matching logic is unit-testable with canned `ps`/PowerShell output and
 * no real processes. Best-effort: any failure yields an empty list, never throws.
 */
import { execFile } from "node:child_process";

export interface RunningClaude {
  pid: number;
  /** The --session-id it was started with, if present on the command line. */
  sessionId?: string;
  /** The full command line (trimmed, capped) — shown so the user can recognize it. */
  commandLine: string;
}

/** Returns the raw process listing ("<pid> <commandline>" per line). */
export type ProcRunner = () => Promise<string>;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SESSION_ID = /--session-id[ =]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CMD_CAP = 300;

/**
 * Parse a normalized process listing — each line "<pid> <commandline>" — into the
 * Claude Code processes. A line counts as claude when its command line mentions
 * `claude` AND isn't this orchestrator itself (we skip our own node/tsx procs and
 * the scan command). Dedupes by pid.
 */
export function parseProcessList(raw: string): RunningClaude[] {
  const byPid = new Map<number, RunningClaude>();
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const commandLine = m[2];
    if (!Number.isFinite(pid) || !commandLine) continue;
    // Must look like Claude Code, but not our own orchestrator / the scan itself.
    if (!/claude/i.test(commandLine)) continue;
    if (/agi-orchestrator|src[\\/]server[\\/]index|Win32_Process|processScan/i.test(commandLine)) continue;
    // A bare "claude" launcher with no agent activity is fine to list; require it
    // to actually be the CLI (path to claude, or the `claude` command token).
    if (!/(^|[\\/\s"])claude(\.exe|\.cmd|\.js)?($|[\s"])/i.test(commandLine) && !/claude[\\/]/i.test(commandLine)) {
      continue;
    }
    const sid = commandLine.match(SESSION_ID)?.[1];
    const entry: RunningClaude = {
      pid,
      commandLine: commandLine.length > CMD_CAP ? commandLine.slice(0, CMD_CAP) + "…" : commandLine,
    };
    if (sid && UUID.test(sid)) entry.sessionId = sid.toLowerCase();
    byPid.set(pid, entry);
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}

/** Default OS runner: PowerShell on Windows, `ps` elsewhere. Never rejects. */
const defaultProcRunner: ProcRunner = () =>
  new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const cmd = isWin ? "powershell.exe" : "ps";
    const args = isWin
      ? [
          "-NoProfile",
          "-Command",
          // Emit "<pid> <commandline>" for every process that mentions claude.
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'claude' } | " +
            "ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
        ]
      : ["-axww", "-o", "pid=,command="];
    execFile(cmd, args, { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout) => {
      resolve((stdout ?? "").toString());
    });
  });

/** Scan for running Claude Code processes (best-effort; [] on any failure). */
export async function scanRunningClaude(runner: ProcRunner = defaultProcRunner): Promise<RunningClaude[]> {
  try {
    return parseProcessList(await runner());
  } catch {
    return [];
  }
}
