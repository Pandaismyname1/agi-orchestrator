/**
 * Deterministic tests for the fleet search/filter matcher (web/src/lib/filter.ts).
 * Pure logic, no Svelte runtime — imported directly. AND-across-terms, case-
 * insensitive substring across id/goal/cwd/status/mode/autonomy/permissionMode.
 */
import { matchesQuery, filterSessions, queryTerms, type FilterableSession } from "../web/src/lib/filter.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const sessions: FilterableSession[] = [
  { id: "api-server", goal: "Build the REST API with auth", cwd: "C:\\dev\\api", status: "running", mode: "autopilot", autonomy: "balanced", permissionMode: "acceptEdits" },
  { id: "docs-site", goal: "Write and polish the documentation site", cwd: "C:\\dev\\docs", status: "done", mode: "autopilot", autonomy: "cautious", permissionMode: "default" },
  { id: "deploy-prod", goal: "Deploy the API to production", cwd: "C:\\dev\\api", status: "needs-input", mode: "manual", autonomy: "autonomous", permissionMode: "bypassPermissions" },
];

// ── empty query ───────────────────────────────────────────────────────────────
check("empty query matches everything", filterSessions(sessions, "").length === 3);
check("whitespace query matches everything", filterSessions(sessions, "   ").length === 3);
check("empty query returns the SAME array ref (no copy)", filterSessions(sessions, "") === sessions);
check("queryTerms drops blanks", queryTerms("  api   server ").length === 2);

// ── by id / name ──────────────────────────────────────────────────────────────
check("matches by id substring", filterSessions(sessions, "docs").map((s) => s.id).join() === "docs-site");
check("case-insensitive", filterSessions(sessions, "DOCS").length === 1);

// ── by status ─────────────────────────────────────────────────────────────────
check("matches by status", filterSessions(sessions, "needs-input").map((s) => s.id).join() === "deploy-prod");
check("matches by status word", filterSessions(sessions, "running").length === 1);

// ── by type/mode/autonomy/permission ──────────────────────────────────────────
check("matches by mode (type)", filterSessions(sessions, "manual").map((s) => s.id).join() === "deploy-prod");
check("matches by permissionMode", filterSessions(sessions, "bypass").map((s) => s.id).join() === "deploy-prod");
check("matches by autonomy", filterSessions(sessions, "cautious").map((s) => s.id).join() === "docs-site");

// ── by goal / cwd ─────────────────────────────────────────────────────────────
check("matches by goal text", filterSessions(sessions, "documentation").map((s) => s.id).join() === "docs-site");
check("matches by cwd", filterSessions(sessions, "dev\\api").length === 2);

// ── AND across terms ──────────────────────────────────────────────────────────
check("two terms AND together", filterSessions(sessions, "api running").map((s) => s.id).join() === "api-server");
check("two terms with no common session → none", filterSessions(sessions, "docs running").length === 0);
check("terms can match different fields", filterSessions(sessions, "deploy manual").map((s) => s.id).join() === "deploy-prod");

// ── no match ──────────────────────────────────────────────────────────────────
check("no match → empty", filterSessions(sessions, "zzzznope").length === 0);
check("matchesQuery direct: true", matchesQuery(sessions[0]!, "auth"));
check("matchesQuery direct: false", !matchesQuery(sessions[0]!, "production"));

// missing optional fields don't throw.
check("tolerates a bare session", matchesQuery({ id: "x" }, "x") && !matchesQuery({ id: "x" }, "y"));

console.log(`\n[filter] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
