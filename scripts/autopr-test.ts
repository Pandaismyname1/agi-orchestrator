/**
 * Deterministic test for auto-PR-on-done (Tier 3 #10). Exercises openPullRequest
 * + helpers through an INJECTED runner — no real git, gh, or network. Asserts the
 * guard order, the exact command sequence, draft vs ready, branch reuse, the
 * "nothing ahead" skip, and idempotent recovery of an existing PR.
 */
import {
  openPullRequest,
  slugify,
  branchName,
  prTitle,
  detectBase,
  type Runner,
  type RunResult,
} from "../src/git/pr.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1): RunResult => ({ code, stdout: "", stderr });

/** Build a runner from a responder; records every (cmd args) string. */
function mockRunner(responder: (cmd: string, args: string[]) => RunResult): { run: Runner; calls: string[] } {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return responder(cmd, args);
  };
  return { run, calls };
}

/** A responder for the happy path; `over` lets a test override specific commands. */
function happy(over: (cmd: string, args: string[]) => RunResult | undefined = () => undefined) {
  return (cmd: string, args: string[]): RunResult => {
    const o = over(cmd, args);
    if (o) return o;
    const a = args.join(" ");
    if (cmd === "git" && a === "rev-parse --is-inside-work-tree") return ok("true");
    if (cmd === "git" && a === "remote get-url origin") return ok("git@github.com:me/repo.git");
    if (cmd === "gh" && a === "--version") return ok("gh version 2.0.0");
    if (cmd === "git" && a.startsWith("symbolic-ref")) return ok("refs/remotes/origin/main");
    if (cmd === "git" && a.startsWith("rev-parse --verify --quiet refs/heads/")) return fail("", 1); // branch doesn't exist
    if (cmd === "git" && a.startsWith("checkout")) return ok();
    if (cmd === "git" && a === "status --porcelain") return ok(" M src/app.ts\n");
    if (cmd === "git" && a === "add -A") return ok();
    if (cmd === "git" && a.startsWith("commit")) return ok("[branch abc] msg");
    if (cmd === "git" && a.startsWith("rev-parse --verify --quiet refs/remotes/origin/")) return ok("deadbeef");
    if (cmd === "git" && a.startsWith("rev-list --count")) return ok("3");
    if (cmd === "git" && a.startsWith("push")) return ok();
    if (cmd === "gh" && a.startsWith("pr create")) return ok("https://github.com/me/repo/pull/42\n");
    return ok();
  };
}

const META = { sessionId: "Refactor-DB", goal: "Migrate the data layer to the query builder", doneCriteria: "tests green" };

// ── helpers ────────────────────────────────────────────────────────────────
check("slugify lowercases + kebabs", slugify("Migrate the Data Layer!") === "migrate-the-data-layer");
check("slugify caps length", slugify("a".repeat(100), 10).length <= 10);
check("slugify empty → 'work'", slugify("!!!") === "work");
check("branchName has agi/ prefix", branchName("s1", "do thing").startsWith("agi/"));
check("prTitle takes the first line", prTitle("Add auth\nand tests") === "Add auth");
check("prTitle caps long goals", prTitle("x".repeat(100)).length <= 72);

// ── guards (each aborts as a skip, in order) ─────────────────────────────────
{
  const { run } = mockRunner((c, a) => (c === "git" && a.join(" ") === "rev-parse --is-inside-work-tree" ? ok("false") : ok()));
  const r = await openPullRequest("/x", { mode: "draft", ...META }, run);
  check("not-a-repo → skipped", r.skipped === true && !r.ok);
}
{
  const { run } = mockRunner((c, a) => {
    const s = `${c} ${a.join(" ")}`;
    if (s === "git rev-parse --is-inside-work-tree") return ok("true");
    if (s === "git remote get-url origin") return fail("no origin", 2);
    return ok();
  });
  const r = await openPullRequest("/x", { mode: "draft", ...META }, run);
  check("no origin remote → skipped", r.skipped === true && /origin/.test(r.reason ?? ""));
}
{
  const { run } = mockRunner((c, a) => {
    const s = `${c} ${a.join(" ")}`;
    if (s === "git rev-parse --is-inside-work-tree") return ok("true");
    if (s === "git remote get-url origin") return ok("url");
    if (s === "gh --version") return fail("not found", 127);
    return ok();
  });
  const r = await openPullRequest("/x", { mode: "draft", ...META }, run);
  check("no gh CLI → skipped", r.skipped === true && /gh/.test(r.reason ?? ""));
}

// ── happy path (draft) ───────────────────────────────────────────────────────
{
  const { run, calls } = mockRunner(happy());
  const r = await openPullRequest("/x", { mode: "draft", ...META, turns: 7 }, run);
  check("draft: ok with parsed URL", r.ok && r.url === "https://github.com/me/repo/pull/42");
  check("draft: branch is agi/<id>-<goal>", (r.branch ?? "").startsWith("agi/refactor-db-"));
  check("draft: created a new branch (checkout -b)", calls.some((c) => c.startsWith("git checkout -b agi/")));
  check("draft: committed pending work", calls.includes("git add -A") && calls.some((c) => c.startsWith("git commit")));
  check("draft: pushed with -u origin", calls.some((c) => c.startsWith("git push -u origin agi/")));
  check("draft: gh pr create carries --draft", calls.some((c) => c.startsWith("gh pr create") && c.includes("--draft")));
  check("draft: base resolved to main", calls.some((c) => c.startsWith("gh pr create") && c.includes("--base main")));
}

// ── ready mode omits --draft ─────────────────────────────────────────────────
{
  const { run, calls } = mockRunner(happy());
  const r = await openPullRequest("/x", { mode: "ready", ...META }, run);
  check("ready: ok", r.ok);
  check("ready: gh pr create has NO --draft", calls.some((c) => c.startsWith("gh pr create")) && !calls.some((c) => c.includes("--draft")));
}

// ── explicit base overrides detection ────────────────────────────────────────
{
  const { run, calls } = mockRunner(happy());
  await openPullRequest("/x", { mode: "ready", base: "develop", ...META }, run);
  check("explicit base is used", calls.some((c) => c.startsWith("gh pr create") && c.includes("--base develop")));
  check("explicit base skips symbolic-ref detection", !calls.some((c) => c.startsWith("git symbolic-ref")));
}

// ── existing branch → checkout (not -b) ──────────────────────────────────────
{
  const { run, calls } = mockRunner(
    happy((c, a) => (c === "git" && a.join(" ").startsWith("rev-parse --verify --quiet refs/heads/") ? ok("exists") : undefined)),
  );
  await openPullRequest("/x", { mode: "draft", ...META }, run);
  check("existing branch → plain checkout", calls.some((c) => /^git checkout agi\//.test(c)) && !calls.some((c) => c.startsWith("git checkout -b")));
}

// ── clean tree, nothing ahead of base → skipped ──────────────────────────────
{
  const { run, calls } = mockRunner(
    happy((c, a) => {
      const s = `${c} ${a.join(" ")}`;
      if (s === "git status --porcelain") return ok(""); // clean
      if (s.startsWith("git rev-list --count")) return ok("0"); // nothing ahead
      return undefined;
    }),
  );
  const r = await openPullRequest("/x", { mode: "draft", ...META }, run);
  check("nothing ahead → skipped, no push", r.skipped === true && !calls.some((c) => c.startsWith("git push")));
  check("nothing ahead → no commit attempted (clean tree)", !calls.includes("git add -A"));
}

// ── existing PR (gh create fails) → recover its URL via gh pr view ───────────
{
  const { run } = mockRunner(
    happy((c, a) => {
      const s = `${c} ${a.join(" ")}`;
      if (s.startsWith("gh pr create")) return fail("a pull request already exists", 1);
      if (s.startsWith("gh pr view")) return ok("https://github.com/me/repo/pull/7\n");
      return undefined;
    }),
  );
  const r = await openPullRequest("/x", { mode: "draft", ...META }, run);
  check("existing PR → ok and recovered URL", r.ok && r.url === "https://github.com/me/repo/pull/7");
}

// ── push failure surfaces as a non-skip failure ──────────────────────────────
{
  const { run } = mockRunner(happy((c, a) => (c === "git" && a[0] === "push" ? fail("rejected", 1) : undefined)));
  const r = await openPullRequest("/x", { mode: "draft", ...META }, run);
  check("push failure → ok=false, not skipped", !r.ok && !r.skipped && /push/.test(r.reason ?? ""));
}

// ── detectBase parses origin/HEAD, falls back to main ────────────────────────
{
  const { run } = mockRunner((c, a) => (a.join(" ").startsWith("symbolic-ref") ? ok("refs/remotes/origin/trunk") : ok()));
  check("detectBase reads origin/HEAD", (await detectBase("/x", run)) === "trunk");
  const { run: run2 } = mockRunner(() => fail("no HEAD", 1));
  check("detectBase falls back to main", (await detectBase("/x", run2)) === "main");
}

console.log(`\n[autopr] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
