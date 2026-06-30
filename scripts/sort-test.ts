/**
 * Deterministic tests for the fleet sorter (web/src/lib/sort.ts).
 * Pure logic, no Svelte runtime — imported directly. Verifies the attention
 * ranking, plain field sorts, stability of ties, and non-mutation of input.
 */
import { sortSessions, attentionRank, SORT_OPTIONS, type SortableSession } from "../web/src/lib/sort.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};
const ids = (xs: SortableSession[]) => xs.map((s) => s.id).join(",");

const sessions: SortableSession[] = [
  { id: "alpha", status: "done", turns: 12, elapsedMin: 30 },
  { id: "bravo", status: "running", turns: 5, elapsedMin: 90 },
  { id: "charlie", status: "error", turns: 2, elapsedMin: 4 },
  { id: "delta", status: "needs-input", turns: 8, elapsedMin: 15 },
  { id: "echo", status: "queued", turns: 0, elapsedMin: 0 },
];

// ── attention (default) ────────────────────────────────────────────────────────
check(
  "attention: error → needs-input → running → queued → done",
  ids(sortSessions(sessions, "attention")) === "charlie,delta,bravo,echo,alpha",
);
check("attentionRank: error beats running", attentionRank("error") < attentionRank("running"));
check("attentionRank: unknown sits mid-pack (not top)", attentionRank("weird") > attentionRank("blocked"));
check("attentionRank: missing status is unknown rank", attentionRank(undefined) === attentionRank("weird"));

// ── name ────────────────────────────────────────────────────────────────────────
check("name: alphabetical", ids(sortSessions(sessions, "name")) === "alpha,bravo,charlie,delta,echo");
check(
  "name: numeric-aware (api2 before api10)",
  ids(sortSessions([{ id: "api10" }, { id: "api2" }], "name")) === "api2,api10",
);

// ── turns (most active) ──────────────────────────────────────────────────────────
check("turns: most active first", ids(sortSessions(sessions, "turns")) === "alpha,delta,bravo,charlie,echo");

// ── runtime (longest running) ────────────────────────────────────────────────────
check("runtime: longest first", ids(sortSessions(sessions, "runtime")) === "bravo,alpha,delta,charlie,echo");

// ── stability ────────────────────────────────────────────────────────────────────
const tied: SortableSession[] = [
  { id: "first", status: "running" },
  { id: "second", status: "running" },
  { id: "third", status: "running" },
];
check("stable: equal ranks keep input order", ids(sortSessions(tied, "attention")) === "first,second,third");

// ── non-mutation ─────────────────────────────────────────────────────────────────
const original = ids(sessions);
sortSessions(sessions, "name");
check("input array is not mutated", ids(sessions) === original);

// ── defaults / metadata ──────────────────────────────────────────────────────────
check("SORT_OPTIONS has 4 keys starting with attention", SORT_OPTIONS.length === 4 && SORT_OPTIONS[0]!.key === "attention");
check("tolerates missing fields", ids(sortSessions([{ id: "x" }, { id: "a" }], "name")) === "a,x");

console.log(`\n[sort] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
