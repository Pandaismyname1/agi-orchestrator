/**
 * Git ground-truth for the brain (Tier 2 #5 — smarter brain context).
 *
 * The operator decides "continue / stop / escalate" from the agent's last
 * MESSAGE — but the message is a claim ("done, committed the HUD"), not proof.
 * The reliable signal is the repo itself: is the tree clean, what files changed,
 * how big is the diff, what's the last commit. Feeding a compact summary of that
 * to the brain lets it catch "claims work it never did" and "fixates on a step
 * that produced no changes" — the two failure modes the long-run flagged.
 *
 * Pure read-side and defensive: a non-repo cwd, a missing git, or any failure
 * yields "" (no REPO STATE block → behavior identical to before).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** Run one git command in `cwd`; return stdout or null on any failure. */
async function git(cwd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  try {
    const { stdout } = await pexec("git", args, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1 << 20, // 1 MiB — plenty; we only read short status/stat output
    });
    return stdout;
  } catch {
    return null; // not a repo, git missing, timeout — all non-fatal
  }
}

export interface GitSummaryOpts {
  /** Max changed files to list before collapsing to "…and N more" (default 20). */
  maxFiles?: number;
}

/**
 * A compact, human-readable snapshot of the working tree for the brain:
 * branch, last commit, and either "CLEAN" or the changed-file list + diffstat.
 * Returns "" when `cwd` is not a git work tree (or git is unavailable).
 */
export async function gitSummary(cwd: string, opts?: GitSummaryOpts): Promise<string> {
  const maxFiles = opts?.maxFiles ?? 20;

  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside || inside.trim() !== "true") return "";

  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || "?";
  const lastCommit = (await git(cwd, ["log", "-1", "--format=%h %s"]))?.trim() || "";
  const statusRaw = (await git(cwd, ["status", "--porcelain"])) ?? "";

  const files = statusRaw
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter(Boolean);

  const parts: string[] = [`branch ${branch}`];
  if (lastCommit) parts.push(`last commit: ${lastCommit}`);

  if (files.length === 0) {
    parts.push("working tree CLEAN (no uncommitted changes since the last commit)");
    return parts.join("\n");
  }

  parts.push(`${files.length} uncommitted file(s):`);
  parts.push(files.slice(0, maxFiles).map((l) => `  ${l}`).join("\n"));
  if (files.length > maxFiles) parts.push(`  …and ${files.length - maxFiles} more`);

  const unstaged = (await git(cwd, ["diff", "--shortstat"]))?.trim() || "";
  const staged = (await git(cwd, ["diff", "--cached", "--shortstat"]))?.trim() || "";
  const stat = [unstaged && `unstaged ${unstaged}`, staged && `staged ${staged}`]
    .filter(Boolean)
    .join("; ");
  if (stat) parts.push(stat);

  return parts.join("\n");
}
