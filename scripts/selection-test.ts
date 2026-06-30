/**
 * Deterministic tests for the bulk-action selection helpers
 * (web/src/lib/selection.ts). Pure logic, imported directly via tsx.
 */
import {
  canStart,
  canStop,
  canDelete,
  canDo,
  actionableIds,
  orderByDeps,
  type SelectableSession,
  type DependentSession,
} from "../web/src/lib/selection.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── predicates ────────────────────────────────────────────────────────────────
check("startable: idle/stopped/done/error/blocked", ["idle", "stopped", "done", "error", "blocked"].every(canStart));
check("not startable: running/manual/needs-input/paused/queued", ["running", "manual", "needs-input", "paused", "queued"].every((s) => !canStart(s)));
check("stoppable: running/manual/needs-input/paused/queued/blocked", ["running", "manual", "needs-input", "paused", "queued", "blocked"].every(canStop));
check("not stoppable: idle/done/stopped/error", ["idle", "done", "stopped", "error"].every((s) => !canStop(s)));
check("canDo routes by action", canDo("start", "idle") && canDo("stop", "running") && !canDo("start", "running"));
check("undefined status is neither", !canStart(undefined) && !canStop(undefined));

// ── delete predicate (anything not actively running) ────────────────────────────
check("deletable: idle/done/error/stopped/queued/needs-input/manual/blocked", ["idle", "done", "error", "stopped", "queued", "needs-input", "manual", "blocked"].every(canDelete));
check("not deletable: running", !canDelete("running"));
check("undefined status is deletable (no live PTY)", canDelete(undefined));
check("canDo routes delete", canDo("delete", "done") && !canDo("delete", "running"));

// ── actionableIds ─────────────────────────────────────────────────────────────
const sessions: SelectableSession[] = [
  { id: "a", status: "idle" },
  { id: "b", status: "running" },
  { id: "c", status: "done" },
  { id: "d", status: "needs-input" },
  { id: "e", status: "queued" },
];

const all = new Set(["a", "b", "c", "d", "e"]);
check("start applies only to startable selected", actionableIds(sessions, all, "start").join() === "a,c");
check("stop applies only to stoppable selected", actionableIds(sessions, all, "stop").join() === "b,d,e");

const some = new Set(["a", "b"]);
check("respects the selection set", actionableIds(sessions, some, "start").join() === "a" && actionableIds(sessions, some, "stop").join() === "b");

check("empty selection → none", actionableIds(sessions, new Set(), "start").length === 0);
check("selected id not in list is ignored", actionableIds(sessions, new Set(["zzz"]), "start").length === 0);
check("result order follows the session list", actionableIds(sessions, all, "stop").join() === "b,d,e");
check("delete applies to all non-running selected", actionableIds(sessions, all, "delete").join() === "a,c,d,e");

// ── orderByDeps (re-add order for undo) ─────────────────────────────────────────
const ids = (xs: DependentSession[]) => xs.map((x) => x.id).join(",");
// A depends on B, C depends on A → must re-add B, A, C.
const chain: DependentSession[] = [
  { id: "A", dependsOn: ["B"] },
  { id: "B" },
  { id: "C", dependsOn: ["A"] },
];
check("orderByDeps puts dependencies first", ids(orderByDeps(chain)) === "B,A,C");
check("independent items keep input order (stable)", ids(orderByDeps([{ id: "x" }, { id: "y" }, { id: "z" }])) === "x,y,z");
check("deps outside the set are ignored", ids(orderByDeps([{ id: "A", dependsOn: ["external"] }])) === "A");
check("orderByDeps preserves the full set", orderByDeps(chain).length === 3);
// A cycle must not hang or drop items.
const cycle: DependentSession[] = [
  { id: "P", dependsOn: ["Q"] },
  { id: "Q", dependsOn: ["P"] },
];
check("orderByDeps tolerates a cycle (no hang, keeps all)", orderByDeps(cycle).length === 2);
check("orderByDeps does not mutate input", chain[0]!.id === "A" && chain.length === 3);

console.log(`\n[selection] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
