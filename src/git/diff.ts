/**
 * Per-turn git snapshots + diffs (observability). Lets the dashboard show exactly
 * what an agent changed on each turn — and is the basis for rolling a step back.
 *
 * NON-INVASIVE by construction: we never touch the real index or working tree.
 * A snapshot is taken by building a throwaway tree from a TEMP index
 * (GIT_INDEX_FILE), so it captures the complete working state — including NEW /
 * untracked files an agent created (which `git stash create` would miss) — while
 * respecting .gitignore (so node_modules etc. stay out). The per-turn delta is
 * just `git diff <prevSnapshot> <curSnapshot>`.
 *
 * Everything is best-effort: a non-repo cwd, a repo with no commits yet, or any
 * git hiccup yields null/empty rather than throwing, so a run is never disturbed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** One file's change in a turn. `added`/`removed` are -1 for binary files. */
export interface FileDelta {
  file: string;
  added: number;
  removed: number;
}

/** The change an agent made in a single turn. */
export interface TurnDiff {
  files: FileDelta[];
  /** Unified-diff patch text (capped — see PATCH_CAP). */
  patch: string;
  /** True when `patch` was truncated to the cap. */
  truncated: boolean;
}

const PATCH_CAP = 60_000; // keep the DB row sane; the file list is always complete

/** Run a git command in `cwd`, returning trimmed stdout or null on any failure. */
function git(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    }).trim();
  } catch {
    return null;
  }
}

/** True if `cwd` is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

/**
 * Pin a snapshot commit under refs/agi/snap/<sha> so git GC can never prune it —
 * the per-turn snapshots must survive long enough to roll back to. Idempotent.
 */
export function protectSnapshot(cwd: string, sha: string | null): void {
  if (!sha) return;
  git(cwd, ["update-ref", `refs/agi/snap/${sha}`, sha]);
}

/** True if `sha` resolves to a real commit (or tree) object in this repo. */
export function snapshotExists(cwd: string, sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return false;
  return (
    git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) !== null ||
    git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]) !== null
  );
}

/** Outcome of a rollback. `backupSha` is a pinned snapshot of the pre-rollback state. */
export interface RestoreResult {
  ok: boolean;
  backupSha?: string;
  error?: string;
}

/**
 * Restore the working tree + index to EXACTLY match snapshot `sha` — re-adding
 * files deleted since, removing files created since, and reverting edits — WITHOUT
 * moving HEAD or touching .gitignored paths. A safety snapshot of the current
 * state is pinned first so the rollback is itself recoverable.
 *
 * Caller MUST ensure no agent/PTY is touching the repo concurrently.
 */
export function restoreTo(cwd: string, sha: string): RestoreResult {
  if (!isGitRepo(cwd)) return { ok: false, error: "not a git repository" };
  if (!snapshotExists(cwd, sha)) return { ok: false, error: "snapshot not found in this repo" };
  // Safety net: pin the current state so the operator can undo the rollback.
  const backupSha = snapshotRef(cwd);
  protectSnapshot(cwd, backupSha);
  const bk = backupSha ?? undefined;
  // Make index+worktree match the snapshot tree EXACTLY, without moving HEAD:
  //   1) point the index at the snapshot tree,
  //   2) force-write every one of those files to the working tree (reverts edits,
  //      restores deleted files),
  //   3) remove files added since (now untracked) — `clean -fd` keeps .gitignored
  //      paths (no -x), so node_modules etc. are never touched.
  if (git(cwd, ["read-tree", "--reset", `${sha}^{tree}`]) === null) {
    return { ok: false, error: "restore failed (read-tree)", backupSha: bk };
  }
  if (git(cwd, ["checkout-index", "-f", "-a"]) === null) {
    return { ok: false, error: "restore failed (checkout-index)", backupSha: bk };
  }
  git(cwd, ["clean", "-fd"]); // best-effort; nothing-to-clean is not a failure
  return { ok: true, backupSha: bk };
}

/**
 * Snapshot the FULL current working tree (tracked + untracked, minus ignored) as
 * a dangling commit and return its sha — without touching the real index/worktree.
 * Returns null if `cwd` isn't a usable repo.
 */
export function snapshotRef(cwd: string): string | null {
  if (!isGitRepo(cwd)) return null;
  let tmpDir: string | null = null;
  try {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agi-gitidx-"));
    const idx = path.join(tmpDir, "index");
    const env = { GIT_INDEX_FILE: idx };
    // Stage everything from the working tree into the TEMP index (respects .gitignore).
    if (git(cwd, ["add", "-A"], env) === null) return null;
    const tree = git(cwd, ["write-tree"], env);
    if (!tree) return null;
    // Parent the snapshot on HEAD when there is one (so a root-less repo still works).
    const head = git(cwd, ["rev-parse", "--verify", "HEAD"]);
    const args = head ? ["commit-tree", tree, "-p", head, "-m", "agi-snapshot"] : ["commit-tree", tree, "-m", "agi-snapshot"];
    return git(cwd, args, env);
  } catch {
    return null;
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }
}

/** Parse `git diff --numstat` output into FileDeltas. */
export function parseNumstat(out: string): FileDelta[] {
  const files: FileDelta[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("\t");
    if (parts.length < 3) continue;
    const [a, r, ...rest] = parts;
    const file = rest.join("\t");
    files.push({
      file,
      added: a === "-" ? -1 : Number(a) || 0,
      removed: r === "-" ? -1 : Number(r) || 0,
    });
  }
  return files;
}

/**
 * The diff between two snapshot refs (the per-turn delta). Returns an empty diff
 * (no files, empty patch) when the refs are equal/missing or nothing changed, and
 * null only when the refs can't be diffed at all.
 */
export function turnDiff(cwd: string, fromRef: string | null, toRef: string | null): TurnDiff | null {
  if (!toRef) return null;
  // First turn against a baseline-less repo, or no change → nothing to show.
  if (!fromRef || fromRef === toRef) return { files: [], patch: "", truncated: false };
  const numstat = git(cwd, ["diff", "--numstat", fromRef, toRef]);
  if (numstat === null) return null;
  const files = parseNumstat(numstat);
  if (files.length === 0) return { files: [], patch: "", truncated: false };
  const raw = git(cwd, ["diff", fromRef, toRef]) ?? "";
  const truncated = raw.length > PATCH_CAP;
  const patch = truncated ? raw.slice(0, PATCH_CAP) + "\n… (diff truncated)" : raw;
  return { files, patch, truncated };
}
