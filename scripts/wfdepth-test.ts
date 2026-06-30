/**
 * Deterministic tests for the workflow depth policy (src/policy/wfdepth.ts).
 * Pure logic — no supervisor. Covers chain-depth computation, the whole-graph
 * max, cap comparison (incl. disable), cycle tolerance, and the with-edge
 * pre-validation the builder uses.
 */
import {
  chainDepthOf,
  maxChainDepth,
  overDepthCap,
  depthWithEdge,
  DEFAULT_WORKFLOW_DEPTH_CAP,
  type DepNode,
} from "../src/policy/wfdepth.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// A linear chain a → b → c → d (each runs after the previous).
const chain: DepNode[] = [
  { id: "a" },
  { id: "b", dependsOn: ["a"] },
  { id: "c", dependsOn: ["b"] },
  { id: "d", dependsOn: ["c"] },
];

// ── chainDepthOf ─────────────────────────────────────────────────────────────────
check("root has depth 1", chainDepthOf(chain, "a") === 1);
check("second step has depth 2", chainDepthOf(chain, "b") === 2);
check("fourth step has depth 4", chainDepthOf(chain, "d") === 4);
check("unknown id → 0", chainDepthOf(chain, "zzz") === 0);

// diamond: a → b, a → c, b → d, c → d  (d's longest path is a→b→d = 3)
const diamond: DepNode[] = [
  { id: "a" },
  { id: "b", dependsOn: ["a"] },
  { id: "c", dependsOn: ["a"] },
  { id: "d", dependsOn: ["b", "c"] },
];
check("diamond join takes the LONGEST path", chainDepthOf(diamond, "d") === 3);

// multiple deps of differing depth → 1 + the deepest
const uneven: DepNode[] = [
  { id: "a" },
  { id: "b", dependsOn: ["a"] },
  { id: "c", dependsOn: ["b"] },
  { id: "x", dependsOn: ["a", "c"] }, // deepest dep is c(3) → x = 4
];
check("node takes 1 + deepest dependency", chainDepthOf(uneven, "x") === 4);

// ── maxChainDepth ────────────────────────────────────────────────────────────────
check("max over a linear chain is its length", maxChainDepth(chain) === 4);
check("max over the diamond is 3", maxChainDepth(diamond) === 3);
check("empty workflow → 0", maxChainDepth([]) === 0);
check("all-roots workflow → 1", maxChainDepth([{ id: "a" }, { id: "b" }]) === 1);

// ── cycle tolerance ──────────────────────────────────────────────────────────────
const cyclic: DepNode[] = [
  { id: "a", dependsOn: ["c"] },
  { id: "b", dependsOn: ["a"] },
  { id: "c", dependsOn: ["b"] },
];
check("a cycle does not loop forever (terminates)", Number.isFinite(maxChainDepth(cyclic)));
check("self-edge is ignored", chainDepthOf([{ id: "a", dependsOn: ["a"] }], "a") === 1);
check("unknown dep id is ignored", chainDepthOf([{ id: "b", dependsOn: ["ghost"] }], "b") === 1);

// ── overDepthCap ─────────────────────────────────────────────────────────────────
check("at cap is NOT over", !overDepthCap(10, 10));
check("one past cap is over", overDepthCap(11, 10));
check("cap 0 disables the guard", !overDepthCap(999, 0));
check("negative cap disables the guard", !overDepthCap(999, -1));
check("default cap is 10", DEFAULT_WORKFLOW_DEPTH_CAP === 10);

// ── depthWithEdge (builder pre-validation) ───────────────────────────────────────
// chain is a→b→c→d (depth 4). Adding d → a (a runs after d) would make the longest
// chain a..d then continue? No: a→...; adding edge from=d to=a means a.dependsOn+=d,
// creating a cycle; cycle-guarded so it stays finite. Use a clean extension instead:
const twoChains: DepNode[] = [
  { id: "a" },
  { id: "b", dependsOn: ["a"] }, // depth 2
  { id: "x" }, // separate root, depth 1
];
check("adding an edge extends the chain depth", depthWithEdge(twoChains, "b", "x") === 3); // x runs after b → 3
check("depthWithEdge does not mutate input", (() => {
  const before = JSON.stringify(twoChains);
  depthWithEdge(twoChains, "b", "x");
  return JSON.stringify(twoChains) === before;
})());
check("adding a redundant shallow edge keeps the max", depthWithEdge(chain, "a", "b") === 4);

console.log(`\n[wfdepth] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
