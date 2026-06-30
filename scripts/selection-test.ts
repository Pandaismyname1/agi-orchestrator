/**
 * Deterministic tests for the bulk-action selection helpers
 * (web/src/lib/selection.ts). Pure logic, imported directly via tsx.
 */
import { canStart, canStop, canDo, actionableIds, type SelectableSession } from "../web/src/lib/selection.ts";

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

console.log(`\n[selection] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
