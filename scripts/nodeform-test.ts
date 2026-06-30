/**
 * Deterministic tests for the quick-create draft builder (web/src/lib/nodeform.ts).
 * Pure logic, imported directly via tsx. Covers trim, required fields, default
 * done-criteria, and id/mode passthrough.
 */
import { buildSessionDraft, DEFAULT_DONE } from "../web/src/lib/nodeform.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── happy path ─────────────────────────────────────────────────────────────────
const r = buildSessionDraft({ id: "x1", cwd: "  C:\\dev\\api  ", goal: "  Build it  ", doneCriteria: " tests pass ", mode: "manual" });
check("ok for a complete draft", r.ok);
if (r.ok) {
  check("trims cwd", r.draft.cwd === "C:\\dev\\api");
  check("trims goal", r.draft.goal === "Build it");
  check("trims doneCriteria", r.draft.doneCriteria === "tests pass");
  check("passes id through", r.draft.id === "x1");
  check("passes mode through", r.draft.startMode === "manual");
}

// ── defaults ───────────────────────────────────────────────────────────────────
const d = buildSessionDraft({ cwd: "C:\\dev", goal: "ship" });
check("blank doneCriteria → default", d.ok && d.draft.doneCriteria === DEFAULT_DONE);
check("mode defaults to autopilot", d.ok && d.draft.startMode === "autopilot");
check("no id when omitted", d.ok && d.draft.id === undefined);
check("blank id is dropped", buildSessionDraft({ id: "   ", cwd: "c", goal: "g" }).ok && !(buildSessionDraft({ id: "   ", cwd: "c", goal: "g" }) as any).draft.id);

// ── validation ─────────────────────────────────────────────────────────────────
check("missing goal → error", !buildSessionDraft({ cwd: "C:\\dev", goal: "  " }).ok);
check("missing cwd → error", !buildSessionDraft({ cwd: "", goal: "g" }).ok);
{
  const e = buildSessionDraft({ cwd: "c", goal: "" });
  check("goal error mentions goal", !e.ok && /goal/i.test(e.error));
  const e2 = buildSessionDraft({ cwd: "", goal: "g" });
  check("cwd error mentions directory", !e2.ok && /director/i.test(e2.error));
}

console.log(`\n[nodeform] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
