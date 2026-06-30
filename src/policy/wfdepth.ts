/**
 * Workflow depth policy — the longest sequential dependency chain in a workflow.
 *
 * A workflow is the `dependsOn` DAG: an edge `dep → node` means `node` runs after
 * `dep`. The *depth* of a node is how many sequential steps lead up to and include
 * it (a root with no deps is step 1; a node after a root is step 2; …). When a
 * workflow grows past a configurable cap, the supervisor stops auto-promoting it
 * and parks the next step for manual review, and the builder warns when a drawn
 * edge would push a chain past the cap.
 *
 * Pure + cycle-guarded so it's unit-testable and a malformed snapshot can't wedge
 * it. No model calls, no I/O (local-safe).
 */

/** Default max sequential steps in a workflow before further steps need manual review. */
export const DEFAULT_WORKFLOW_DEPTH_CAP = 10;

/** The slice of a session this policy reads. */
export interface DepNode {
  id: string;
  dependsOn?: string[];
}

/**
 * Depth (sequential step count) of the longest dependency chain ENDING at `id`:
 * 1 for a node with no (known) dependencies, else 1 + the deepest dependency.
 * Unknown dep ids and self-edges are ignored; a node caught in a cycle resolves
 * to its non-cyclic depth (the cycle edge contributes nothing) rather than looping.
 */
export function chainDepthOf(nodes: DepNode[], id: string): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (nid: string): number => {
    if (memo.has(nid)) return memo.get(nid)!;
    if (visiting.has(nid)) return 0; // cycle guard — this edge adds no depth
    visiting.add(nid);
    const deps = (byId.get(nid)?.dependsOn ?? []).filter((d) => d !== nid && byId.has(d));
    const v = deps.length ? Math.max(...deps.map(depth)) + 1 : 1;
    visiting.delete(nid);
    memo.set(nid, v);
    return v;
  };
  return byId.has(id) ? depth(id) : 0;
}

/** The deepest chain anywhere in the workflow (0 when there are no nodes). */
export function maxChainDepth(nodes: DepNode[]): number {
  let max = 0;
  for (const n of nodes) max = Math.max(max, chainDepthOf(nodes, n.id));
  return max;
}

/** True when a depth exceeds the cap. A cap ≤ 0 disables the guard (unlimited). */
export function overDepthCap(depth: number, cap: number): boolean {
  return cap > 0 && depth > cap;
}

/**
 * Depth the longest chain would reach if the edge `from → to` were added (i.e.
 * `to` runs after `from`). Used by the builder to validate a drawn edge before
 * committing it. Non-mutating.
 */
export function depthWithEdge(nodes: DepNode[], from: string, to: string): number {
  const sim = nodes.map((n) =>
    n.id === to ? { ...n, dependsOn: [...(n.dependsOn ?? []), from] } : { ...n },
  );
  return maxChainDepth(sim);
}
