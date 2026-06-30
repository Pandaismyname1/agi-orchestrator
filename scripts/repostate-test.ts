/**
 * Deterministic tests for git ground-truth in the brain (smarter brain context).
 * Seeds a throwaway git repo, checks gitSummary on clean/dirty/non-repo cwds, and
 * asserts decideNextStep injects a REPO STATE block only when repoState is present
 * (the no-regression invariant: omitted/empty repoState == today's prompt).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitSummary } from "../src/brain/repoState.js";
import { decideNextStep } from "../src/brain/decide.js";
import type { LocalLLM, ChatMessage } from "../src/brain/provider.js";
import type { SessionConfig } from "../src/types.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\repostate-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── seed a real repo with one commit ───────────────────────────────────────
const REPO = `${ROOT}\\repo`;
mkdirSync(REPO, { recursive: true });
const g = (args: string[]) =>
  execFileSync("git", args, { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString();
g(["init", "-q"]);
g(["config", "user.email", "t@t.t"]);
g(["config", "user.name", "tester"]);
writeFileSync(`${REPO}\\a.txt`, "one\n");
g(["add", "."]);
g(["commit", "-q", "-m", "init a.txt"]);

// ── clean tree ─────────────────────────────────────────────────────────────
let s = await gitSummary(REPO);
check("clean tree reported CLEAN", /working tree CLEAN/.test(s));
check("branch is shown", /branch \S+/.test(s));
check("last commit subject shown", /init a\.txt/.test(s));

// ── dirty tree ─────────────────────────────────────────────────────────────
writeFileSync(`${REPO}\\a.txt`, "one\ntwo\nthree\n");
writeFileSync(`${REPO}\\b.txt`, "new file\n");
s = await gitSummary(REPO);
check("dirty: lists both changed files", /a\.txt/.test(s) && /b\.txt/.test(s));
check("dirty: counts uncommitted files", /uncommitted file/i.test(s));
check("dirty: NOT reported clean", !/CLEAN/.test(s));

// ── non-repo cwd → "" (must live OUTSIDE any repo; .scratch is inside AGI) ──
const PLAIN = join(tmpdir(), `agi-repostate-norepo-${process.pid}`);
rmSync(PLAIN, { recursive: true, force: true });
mkdirSync(PLAIN, { recursive: true });
check("non-repo cwd => empty string", (await gitSummary(PLAIN)) === "");
rmSync(PLAIN, { recursive: true, force: true });

// ── REPO STATE injection through decideNextStep ────────────────────────────
let captured = "";
const stub = {
  chat: async (msgs: ChatMessage[]) => {
    captured = msgs[1]?.content ?? "";
    return JSON.stringify({ action: "stop", reason: "x" });
  },
} as unknown as LocalLLM;
const session = { id: "s", cwd: REPO, goal: "g", doneCriteria: "d" } as SessionConfig;

await decideNextStep(stub, session, "I changed stuff", 3, undefined, undefined, "branch main\n2 uncommitted file(s):");
check("REPO STATE injected when repoState present", /REPO STATE \(git ground truth/.test(captured) && /2 uncommitted file/.test(captured));

captured = "";
await decideNextStep(stub, session, "hi", 3, undefined, undefined, "");
check("no REPO STATE block when repoState empty", !/REPO STATE/.test(captured));

captured = "";
await decideNextStep(stub, session, "hi", 3);
check("no REPO STATE block when repoState omitted (no-regression)", !/REPO STATE/.test(captured));

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[repostate] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
