/**
 * Auto-open a pull request when a session reaches its done-criteria (Tier 3 #10).
 *
 * Turns an autonomous run into a reviewable deliverable: commit the agent's
 * pending changes onto a fresh `agi/<id>-<slug>` branch, push it, and open a PR
 * (draft or ready) against the base branch via the GitHub CLI.
 *
 * Everything runs through an INJECTED runner so the orchestration is fully unit-
 * testable with no real git/gh/network. The default runner shells out with
 * `execFile` (async — a push must never block the single-threaded supervisor) and
 * never throws: a non-zero exit is returned as a value, so the caller decides.
 *
 * Safe by construction: opt-in per session; aborts (skips, never throws) when the
 * cwd isn't a repo, has no `origin`, lacks `gh`, or has nothing to contribute; it
 * only ever creates a NEW branch and never force-pushes or rewrites history.
 */
import { execFile } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command in `cwd`; resolve with its exit code + output (never rejects). */
export type Runner = (cmd: string, args: string[], cwd: string) => Promise<RunResult>;

/** Default runner: async execFile, output captured, failure surfaced as a value. */
export const defaultRunner: Runner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: (stdout ?? "").toString(), stderr: (stderr ?? "").toString() });
    });
  });

export interface OpenPrInput {
  /** "draft" or "ready". */
  mode: "draft" | "ready";
  /** Target branch; defaults to origin's default branch, else "main". */
  base?: string;
  sessionId: string;
  goal: string;
  doneCriteria: string;
  /** Optional run summary woven into the PR body. */
  turns?: number;
}

export interface OpenPrResult {
  ok: boolean;
  /** The PR URL when opened (or an existing PR for the branch). */
  url?: string;
  branch?: string;
  /** Set when we deliberately did nothing (not a failure) — e.g. no changes. */
  skipped?: boolean;
  /** Human-readable reason for a skip or failure. */
  reason?: string;
}

/** Lowercase kebab slug of `text`, ≤ maxLen, for a branch name. */
export function slugify(text: string, maxLen = 40): string {
  const s = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return s || "work";
}

/** Branch name for a session's PR: `agi/<id-slug>-<goal-slug>`. */
export function branchName(sessionId: string, goal: string): string {
  const idSlug = slugify(sessionId, 24);
  const goalSlug = slugify(goal, 32);
  return `agi/${idSlug}-${goalSlug}`.replace(/-+$/g, "");
}

/** PR title from the goal: first line, collapsed, capped. */
export function prTitle(goal: string): string {
  const first = (goal ?? "").split("\n")[0]?.trim().replace(/\s+/g, " ") || "Automated changes";
  return first.length > 72 ? first.slice(0, 69).trimEnd() + "…" : first;
}

/** PR body — the goal, the finish line, and an honest "opened autonomously" note. */
export function prBody(input: OpenPrInput): string {
  const lines = [
    "## What",
    input.goal.trim(),
    "",
    "## Done criteria",
    input.doneCriteria.trim(),
    "",
    "---",
    `_Opened automatically by the AGI orchestrator when this session met its done-criteria` +
      (input.turns ? ` (after ${input.turns} turn${input.turns === 1 ? "" : "s"})` : "") +
      `. Review before merging._`,
  ];
  return lines.join("\n");
}

/** First URL found in text (gh prints the PR URL on success). */
function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0];
}

/**
 * Commit pending work onto a fresh branch, push, and open a PR. Returns a result
 * describing what happened; only throws never (all failures are values).
 */
export async function openPullRequest(cwd: string, input: OpenPrInput, run: Runner = defaultRunner): Promise<OpenPrResult> {
  // 1) Must be a git repo.
  if ((await run("git", ["rev-parse", "--is-inside-work-tree"], cwd)).stdout.trim() !== "true") {
    return { ok: false, skipped: true, reason: "not a git repository" };
  }
  // 2) Must have an origin remote to push to.
  if ((await run("git", ["remote", "get-url", "origin"], cwd)).code !== 0) {
    return { ok: false, skipped: true, reason: "no 'origin' remote" };
  }
  // 3) Must have the GitHub CLI available.
  if ((await run("gh", ["--version"], cwd)).code !== 0) {
    return { ok: false, skipped: true, reason: "GitHub CLI (gh) not found" };
  }

  const base = input.base?.trim() || (await detectBase(cwd, run));
  const branch = branchName(input.sessionId, input.goal);
  const title = prTitle(input.goal);

  // 4) Switch to (or create) the working branch.
  const exists = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd)).code === 0;
  const sw = await run("git", exists ? ["checkout", branch] : ["checkout", "-b", branch], cwd);
  if (sw.code !== 0) {
    return { ok: false, branch, reason: `could not switch to ${branch}: ${sw.stderr.trim() || sw.stdout.trim()}` };
  }

  // 5) Commit any pending work (the agent's changes). Nothing staged-or-dirty is fine.
  const dirty = (await run("git", ["status", "--porcelain"], cwd)).stdout.trim().length > 0;
  if (dirty) {
    await run("git", ["add", "-A"], cwd);
    const commit = await run("git", ["commit", "-m", title], cwd);
    if (commit.code !== 0) {
      return { ok: false, branch, reason: `commit failed: ${commit.stderr.trim() || commit.stdout.trim()}` };
    }
  }

  // 6) Need at least one commit ahead of the base, else a PR would be empty.
  const baseRef = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], cwd)).code === 0
    ? `origin/${base}`
    : base;
  const ahead = Number((await run("git", ["rev-list", "--count", `${baseRef}..HEAD`], cwd)).stdout.trim() || "0");
  if (!Number.isFinite(ahead) || ahead <= 0) {
    return { ok: false, skipped: true, branch, reason: "no commits ahead of base — nothing to open a PR for" };
  }

  // 7) Push the branch.
  const push = await run("git", ["push", "-u", "origin", branch], cwd);
  if (push.code !== 0) {
    return { ok: false, branch, reason: `push failed: ${push.stderr.trim() || push.stdout.trim()}` };
  }

  // 8) Open the PR. If one already exists for this branch, return its URL (idempotent).
  const args = ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", prBody(input)];
  if (input.mode === "draft") args.push("--draft");
  const create = await run("gh", args, cwd);
  if (create.code === 0) {
    return { ok: true, branch, url: firstUrl(create.stdout) };
  }
  // Already-exists (or other) — try to recover the existing PR's URL.
  const view = await run("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], cwd);
  if (view.code === 0 && firstUrl(view.stdout)) {
    return { ok: true, branch, url: firstUrl(view.stdout), reason: "a PR already existed for this branch" };
  }
  return { ok: false, branch, reason: `gh pr create failed: ${create.stderr.trim() || create.stdout.trim()}` };
}

/** origin's default branch (e.g. "main"), falling back to "main". */
export async function detectBase(cwd: string, run: Runner = defaultRunner): Promise<string> {
  const r = await run("git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  if (r.code === 0) {
    const m = r.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  }
  return "main";
}
