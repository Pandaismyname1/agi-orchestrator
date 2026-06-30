/**
 * Deterministic test for per-turn git snapshots/diffs against a REAL temp repo:
 *  - snapshotRef builds a non-invasive working-tree snapshot (incl. untracked),
 *  - turnDiff reports the delta between two snapshots (modified + new files),
 *  - .gitignore is respected (ignored files never appear),
 *  - the real index / working tree are left untouched,
 *  - non-repo dirs and equal refs degrade gracefully.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isGitRepo,
  snapshotRef,
  turnDiff,
  parseNumstat,
  restoreTo,
  snapshotExists,
  protectSnapshot,
} from "../src/git/diff.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const run = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });

const repo = mkdtempSync(path.join(os.tmpdir(), "agi-gitdiff-"));
run(repo, ["init", "-q"]);
run(repo, ["config", "user.email", "test@agi.local"]);
run(repo, ["config", "user.name", "AGI Test"]);

// ---- non-repo + repo detection ---------------------------------------------
const notRepo = mkdtempSync(path.join(os.tmpdir(), "agi-notrepo-"));
check("isGitRepo true for a repo", isGitRepo(repo));
check("isGitRepo false for a plain dir", !isGitRepo(notRepo));
check("snapshotRef null for a non-repo", snapshotRef(notRepo) === null);

// ---- baseline commit --------------------------------------------------------
writeFileSync(path.join(repo, "a.txt"), "hello\n");
run(repo, ["add", "-A"]);
run(repo, ["commit", "-qm", "init"]);

const snap0 = snapshotRef(repo);
check("snapshot after commit returns a sha", !!snap0 && /^[0-9a-f]{40}$/.test(snap0!));

// ---- modify a tracked file + create a NEW (untracked) file ------------------
writeFileSync(path.join(repo, "a.txt"), "hello world\nsecond line\n");
writeFileSync(path.join(repo, "b.txt"), "brand new file\n");
const snap1 = snapshotRef(repo);
check("second snapshot differs from the first", !!snap1 && snap1 !== snap0);

const diff = turnDiff(repo, snap0, snap1);
check("turnDiff returns a result", !!diff);
const fileNames = (diff?.files ?? []).map((f) => f.file).sort();
check("diff includes the modified tracked file", fileNames.includes("a.txt"));
check("diff includes the NEW untracked file", fileNames.includes("b.txt"));
check("patch mentions the new content", !!diff?.patch.includes("hello world"));
check("patch mentions the new file", !!diff?.patch.includes("b.txt"));

// the real index/working tree must be untouched (snapshots are non-invasive).
const stillUntracked = run(repo, ["status", "--porcelain"]).includes("?? b.txt");
check("snapshotting did NOT stage the new file (non-invasive)", stillUntracked);
check("working tree content intact", readFileSync(path.join(repo, "a.txt"), "utf8").includes("second line"));

// ---- .gitignore is respected ------------------------------------------------
writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
writeFileSync(path.join(repo, "ignored.txt"), "secret\n");
const snap2 = snapshotRef(repo);
const diff2 = turnDiff(repo, snap1, snap2);
const names2 = (diff2?.files ?? []).map((f) => f.file);
check("ignored file is NOT captured", !names2.includes("ignored.txt"));
check(".gitignore itself IS captured", names2.includes(".gitignore"));

// ---- equal refs / parsing ---------------------------------------------------
const same = turnDiff(repo, snap1, snap1);
check("equal refs yield an empty diff", !!same && same.files.length === 0 && same.patch === "");
const parsed = parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg/logo.png\n");
check("numstat parses counts", parsed[0]?.added === 3 && parsed[0]?.removed === 1);
check("numstat marks binary as -1", parsed[1]?.added === -1 && parsed[1]?.removed === -1);

check("temp repo created cleanly", existsSync(path.join(repo, ".git")));

// ---- rollback (restoreTo) ---------------------------------------------------
// Fresh repo: commit a baseline, snapshot it, then make a messy set of changes
// (modify + new file + delete a tracked file), and roll back to the snapshot.
const rb = mkdtempSync(path.join(os.tmpdir(), "agi-rollback-"));
run(rb, ["init", "-q"]);
run(rb, ["config", "user.email", "t@a.local"]);
run(rb, ["config", "user.name", "T"]);
writeFileSync(path.join(rb, "keep.txt"), "original\n");
writeFileSync(path.join(rb, "doomed.txt"), "delete me later\n");
run(rb, ["add", "-A"]);
run(rb, ["commit", "-qm", "base"]);

const target = snapshotRef(rb);
protectSnapshot(rb, target);
check("rollback target snapshot exists", !!target && snapshotExists(rb, target!));

// Agent makes a mess: edit keep.txt, create new.txt, delete doomed.txt.
writeFileSync(path.join(rb, "keep.txt"), "MODIFIED by agent\n");
writeFileSync(path.join(rb, "new.txt"), "agent created this\n");
execFileSync("git", ["rm", "-q", "doomed.txt"], { cwd: rb, stdio: ["ignore", "pipe", "ignore"] });

const res = restoreTo(rb, target!);
check("restoreTo reports success", res.ok);
check("restoreTo pinned a backup of the pre-rollback state", !!res.backupSha && snapshotExists(rb, res.backupSha!));

// normalize CRLF — git autocrlf may rewrite line endings on checkout (Windows).
const keepContent = readFileSync(path.join(rb, "keep.txt"), "utf8").replace(/\r/g, "");
check("modified file reverted", keepContent === "original\n");
check("agent-created file removed", !existsSync(path.join(rb, "new.txt")));
check("deleted file restored", existsSync(path.join(rb, "doomed.txt")));

// the backup can itself be restored (rollback is recoverable).
const back = restoreTo(rb, res.backupSha!);
check("can restore the backup (undo the rollback)", back.ok);
check("after undo, agent's file is back", existsSync(path.join(rb, "new.txt")));

// guards: unknown / malformed sha is refused.
check("restoreTo refuses an unknown sha", !restoreTo(rb, "0".repeat(40)).ok);
check("snapshotExists rejects junk", !snapshotExists(rb, "not-a-sha"));

console.log(`\n[gitdiff] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
