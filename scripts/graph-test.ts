/**
 * Deterministic tests for the workflow-graph logic (web/src/lib/graph.ts).
 * Pure functions — imported directly via tsx. Covers edge derivation, layered
 * levels, cycle detection, and the add/remove dependency helpers.
 */
import {
  deriveEdges,
  levelize,
  layeredLayout,
  reachableViaDeps,
  wouldCreateCycle,
  hasEdge,
  withDependency,
  withoutDependency,
  deriveAutomationEdges,
  hasAutomationEdge,
  clampZoom,
  stepZoom,
  fitScale,
  ZOOM_MIN,
  ZOOM_MAX,
  type GraphSession,
  type AutomationRuleLike,
} from "../web/src/lib/graph.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// A → B → C chain, plus D depending on both A and B; E is standalone.
const sessions: GraphSession[] = [
  { id: "A" },
  { id: "B", dependsOn: ["A"] },
  { id: "C", dependsOn: ["B"] },
  { id: "D", dependsOn: ["A", "B"] },
  { id: "E" },
];

// ── deriveEdges ──────────────────────────────────────────────────────────────────
const edges = deriveEdges(sessions);
const edgeStr = edges.map((e) => `${e.from}->${e.to}`).sort().join(",");
check("derives every dependency edge (from=dep, to=dependent)", edgeStr === "A->B,A->D,B->C,B->D");
check("standalone node has no edges", !edges.some((e) => e.from === "E" || e.to === "E"));
check("drops edges to unknown ids", deriveEdges([{ id: "X", dependsOn: ["ghost"] }]).length === 0);
check("drops self-edges", deriveEdges([{ id: "X", dependsOn: ["X"] }]).length === 0);

// ── levelize ─────────────────────────────────────────────────────────────────────
const lv = levelize(sessions);
check("roots at level 0", lv.get("A") === 0 && lv.get("E") === 0);
check("B one past A", lv.get("B") === 1);
check("C two past A (longest path)", lv.get("C") === 2);
check("D = max(dep levels)+1 = 2", lv.get("D") === 2);
check("levelize survives a cycle (no infinite loop)", levelize([{ id: "X", dependsOn: ["Y"] }, { id: "Y", dependsOn: ["X"] }]).get("X") !== undefined);

// ── layeredLayout ────────────────────────────────────────────────────────────────
const pos = layeredLayout(sessions);
check("layout column = level", pos.get("C")!.col === 2 && pos.get("A")!.col === 0);
check("nodes in the same column get distinct rows", pos.get("C")!.row !== pos.get("D")!.row || pos.get("C")!.col !== pos.get("D")!.col);
{
  // A and E are both column 0 → rows 0 and 1.
  const rootRows = ["A", "E"].map((id) => pos.get(id)!.row).sort().join(",");
  check("two roots stack into rows 0,1", rootRows === "0,1");
}

// ── reachability / cycles ────────────────────────────────────────────────────────
check("C reaches A transitively (C→B→A)", reachableViaDeps(sessions, "C", "A"));
check("A does not reach C", !reachableViaDeps(sessions, "A", "C"));
check("adding A→? no: edge C→A would cycle (A already runs before C)", wouldCreateCycle(sessions, "C", "A"));
check("self-edge is a cycle", wouldCreateCycle(sessions, "A", "A"));
check("A→E is safe (no cycle)", !wouldCreateCycle(sessions, "A", "E"));
check("B→C already exists but isn't a cycle to re-affirm", !wouldCreateCycle(sessions, "B", "C"));

// ── hasEdge / add / remove ───────────────────────────────────────────────────────
check("hasEdge true for A→B", hasEdge(sessions, "A", "B"));
check("hasEdge false for A→C", !hasEdge(sessions, "A", "C"));
check("withDependency adds A to C.dependsOn", withDependency(sessions, "A", "C").sort().join(",") === "A,B");
check("withDependency is idempotent (A→B already there)", withDependency(sessions, "A", "B").join(",") === "A");
check("withoutDependency removes B from C", withoutDependency(sessions, "B", "C").length === 0);
check("withoutDependency leaves others (drop A from D)", withoutDependency(sessions, "A", "D").join(",") === "B");

// ── deriveAutomationEdges ────────────────────────────────────────────────────────
const ids = ["A", "B", "C", "D", "E"];
const rules: AutomationRuleLike[] = [
  { id: "r1", name: "deploy after A", on: ["done"], match: { sessionId: "A" }, actions: [{ kind: "start", target: "B" }] },
  { id: "r2", name: "halt B on err", on: ["error"], match: { sessionId: "B" }, actions: [{ kind: "stop", target: "C" }] },
  { id: "r3", name: "self only", on: ["error"], match: { sessionId: "A" }, actions: [{ kind: "stop", target: "$self" }] },
  { id: "r4", name: "notify only", on: ["done"], match: { sessionId: "A" }, actions: [{ kind: "notify" }] },
  { id: "r5", name: "any session", on: ["done"], actions: [{ kind: "start", target: "B" }] }, // no concrete source
  { id: "r6", name: "disabled", enabled: false, match: { sessionId: "A" }, actions: [{ kind: "start", target: "C" }] },
  { id: "r7", name: "unknown target", match: { sessionId: "A" }, actions: [{ kind: "start", target: "ghost" }] },
];
const aEdges = deriveAutomationEdges(rules, ids);
const aStr = aEdges.map((e) => `${e.from}-${e.kind}->${e.to}`).sort().join(",");
check("derives concrete start/stop automation edges only", aStr === "A-start->B,B-stop->C");
check("edge carries trigger events", aEdges.find((e) => e.ruleId === "r1")!.events.join() === "done");
check("edge carries rule name", aEdges.find((e) => e.ruleId === "r1")!.ruleName === "deploy after A");
check("skips $self action", !aEdges.some((e) => e.ruleId === "r3"));
check("skips notify-only rule", !aEdges.some((e) => e.ruleId === "r4"));
check("skips any-session (no concrete source)", !aEdges.some((e) => e.ruleId === "r5"));
check("skips disabled rule", !aEdges.some((e) => e.ruleId === "r6"));
check("skips unknown target id", !aEdges.some((e) => e.to === "ghost"));
check("empty/undefined rules → no edges", deriveAutomationEdges(undefined, ids).length === 0 && deriveAutomationEdges([], ids).length === 0);
check("accepts a Set of ids", deriveAutomationEdges(rules, new Set(ids)).length === 2);
{
  // dedup: two rules producing the same from|to|kind collapse to one edge.
  const dup: AutomationRuleLike[] = [
    { id: "x", match: { sessionId: "A" }, actions: [{ kind: "start", target: "B" }] },
    { id: "y", match: { sessionId: "A" }, actions: [{ kind: "start", target: "B" }] },
  ];
  check("dedups identical automation edges", deriveAutomationEdges(dup, ids).length === 1);
}

// ── hasAutomationEdge ─────────────────────────────────────────────────────────────
check("hasAutomationEdge true for existing A-start->B", hasAutomationEdge(rules, "A", "B"));
check("hasAutomationEdge respects kind", hasAutomationEdge(rules, "A", "B", "start") && !hasAutomationEdge(rules, "A", "B", "stop"));
check("hasAutomationEdge false for missing edge", !hasAutomationEdge(rules, "A", "C"));
check("hasAutomationEdge false on empty rules", !hasAutomationEdge([], "A", "B"));

// ── zoom helpers ──────────────────────────────────────────────────────────────────
check("clampZoom keeps in-range value", clampZoom(1) === 1);
check("clampZoom floors at ZOOM_MIN", clampZoom(0.01) === ZOOM_MIN);
check("clampZoom caps at ZOOM_MAX", clampZoom(99) === ZOOM_MAX);
check("clampZoom: non-finite → 1", clampZoom(NaN) === 1 && clampZoom(Infinity) === 1);
check("stepZoom in/out by step", Math.abs(stepZoom(1, 1, 0.15) - 1.15) < 1e-9 && Math.abs(stepZoom(1, -1, 0.15) - 0.85) < 1e-9);
check("stepZoom clamps at bounds", stepZoom(ZOOM_MAX, 1) === ZOOM_MAX && stepZoom(ZOOM_MIN, -1) === ZOOM_MIN);
check("fitScale shrinks big content to fit", fitScale(2000, 1000, 1000, 600, 24) < 1);
check("fitScale never zooms in past 1", fitScale(100, 100, 1000, 600, 24) === 1);
check("fitScale clamps tiny fit to ZOOM_MIN", fitScale(100000, 100000, 800, 600) === ZOOM_MIN);
check("fitScale degenerate viewport → 1", fitScale(500, 500, 0, 0) === 1);

console.log(`\n[graph] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
