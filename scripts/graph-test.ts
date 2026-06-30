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
  type GraphSession,
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

console.log(`\n[graph] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
