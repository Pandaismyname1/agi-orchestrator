<script lang="ts">
  /**
   * Workflow graph — sessions as nodes, `dependsOn` edges as arrows. Lays the
   * fleet out left-to-right by dependency depth (longest-path ranking) so you can
   * see at a glance what runs after what, and which steps are still blocked. The
   * whole fleet shows here, so it doubles as a dependency-aware overview.
   */
  import type { SessionView } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import Modal from "../Modal.svelte";
  import StatusBadge from "../StatusBadge.svelte";

  let sessions = $derived(wsStore.snapshot?.sessions ?? []);

  const NODE_W = 196;
  const NODE_H = 70;
  const GAP_X = 76;
  const GAP_Y = 20;

  function label(s: SessionView): string {
    const g = (s.goal ?? "").trim().replace(/\s+/g, " ");
    return g.length > 52 ? g.slice(0, 52) + "…" : g || s.id.slice(0, 8);
  }

  // Longest-path level for each node (roots at 0), with a cycle guard (the backend
  // already rejects cycles, but never wedge the UI on a malformed snapshot).
  let layout = $derived.by(() => {
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const level = new Map<string, number>();
    const visiting = new Set<string>();
    const lvl = (id: string): number => {
      if (level.has(id)) return level.get(id)!;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d));
      const v = deps.length ? Math.max(...deps.map(lvl)) + 1 : 0;
      visiting.delete(id);
      level.set(id, v);
      return v;
    };
    for (const s of sessions) lvl(s.id);

    // Group nodes by level (stable order), then assign a row within each column.
    const cols = new Map<number, SessionView[]>();
    for (const s of sessions) {
      const c = level.get(s.id) ?? 0;
      (cols.get(c) ?? cols.set(c, []).get(c)!).push(s);
    }
    const pos = new Map<string, { x: number; y: number; col: number; row: number }>();
    let maxRows = 0;
    for (const [col, list] of cols) {
      list.forEach((s, row) => {
        pos.set(s.id, {
          col,
          row,
          x: col * (NODE_W + GAP_X),
          y: row * (NODE_H + GAP_Y),
        });
      });
      maxRows = Math.max(maxRows, list.length);
    }
    const maxCol = cols.size ? Math.max(...cols.keys()) : 0;

    // Edges: dep (right-center) → dependent (left-center). Amber when the dep is
    // still in the dependent's `blockedBy` set (not satisfied yet).
    const edges: { x1: number; y1: number; x2: number; y2: number; blocked: boolean }[] = [];
    for (const s of sessions) {
      const cp = pos.get(s.id);
      if (!cp) continue;
      for (const dep of s.dependsOn ?? []) {
        const dp = pos.get(dep);
        if (!dp) continue;
        edges.push({
          x1: dp.x + NODE_W,
          y1: dp.y + NODE_H / 2,
          x2: cp.x,
          y2: cp.y + NODE_H / 2,
          blocked: !!s.blockedBy?.includes(dep),
        });
      }
    }

    const width = (maxCol + 1) * (NODE_W + GAP_X) - GAP_X;
    const height = Math.max(1, maxRows) * (NODE_H + GAP_Y) - GAP_Y;
    return { pos, edges, width: Math.max(width, NODE_W), height: Math.max(height, NODE_H) };
  });

  let nodes = $derived(
    sessions
      .map((s) => ({ s, p: layout.pos.get(s.id) }))
      .filter((n): n is { s: SessionView; p: { x: number; y: number; col: number; row: number } } => !!n.p),
  );

  let hasDeps = $derived(sessions.some((s) => (s.dependsOn?.length ?? 0) > 0));

  function path(e: { x1: number; y1: number; x2: number; y2: number }): string {
    const dx = Math.max(28, (e.x2 - e.x1) * 0.5);
    return `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`;
  }

  function open(s: SessionView): void {
    ui.focusId = s.id;
    wsStore.send({ type: "focus", id: s.id });
    ui.closeModal();
  }
</script>

<Modal title="Workflow graph" width={920} onclose={() => ui.closeModal()}>
  {#if sessions.length === 0}
    <div class="wf-empty">No sessions yet — create some and add dependencies to build a workflow.</div>
  {:else}
    {#if !hasDeps}
      <div class="wf-note">
        No dependencies set yet. Edit a session and pick what it “runs after” to chain a workflow —
        dependents auto-start when their prerequisites finish.
      </div>
    {/if}
    <div class="wf-scroll">
      <div class="wf-canvas" style="width:{layout.width}px; height:{layout.height}px;">
        <svg class="wf-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {#each layout.edges as e, i (i)}
            <path d={path(e)} class="wf-edge" class:blocked={e.blocked} />
          {/each}
        </svg>
        {#each nodes as { s, p } (s.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="wf-node {s.status}"
            class:focused={s.id === ui.focusId}
            style="left:{p.x}px; top:{p.y}px; width:{NODE_W}px; height:{NODE_H}px;"
            role="button"
            tabindex="0"
            onclick={() => open(s)}
            onkeydown={(ev) => (ev.key === "Enter" || ev.key === " ") && open(s)}
            title={s.goal}
          >
            <div class="wf-top">
              <span class="wf-label">{label(s)}</span>
            </div>
            <div class="wf-bot">
              <StatusBadge status={s.status} />
              {#if s.blockedBy?.length}
                <span class="wf-wait">waiting on {s.blockedBy.length}</span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</Modal>

<style>
  .wf-empty,
  .wf-note {
    color: var(--faint);
    font-size: 13px;
    line-height: 1.5;
  }
  .wf-empty {
    text-align: center;
    padding: 28px;
  }
  .wf-note {
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    padding: 9px 12px;
    margin-bottom: 12px;
  }
  .wf-scroll {
    overflow: auto;
    max-height: 64vh;
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    background:
      radial-gradient(circle at 1px 1px, var(--border-soft) 1px, transparent 0) 0 0 / 22px 22px;
    padding: 16px;
  }
  .wf-canvas {
    position: relative;
  }
  .wf-edges {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }
  .wf-edge {
    fill: none;
    stroke: var(--st-done, #60a5fa);
    stroke-width: 2;
    opacity: 0.55;
  }
  .wf-edge.blocked {
    stroke: var(--st-stopped, #fbbf24);
    stroke-dasharray: 5 4;
    opacity: 0.85;
  }
  .wf-node {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 6px;
    padding: 9px 11px;
    border-radius: 11px;
    background: var(--color-base-100);
    border: 1px solid var(--border-strong);
    border-left: 3px solid var(--faint);
    cursor: pointer;
    transition:
      transform 0.1s,
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .wf-node:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
  }
  .wf-node.focused {
    box-shadow: 0 0 0 2px var(--color-primary);
  }
  /* status accent on the left bar */
  .wf-node.running {
    border-left-color: var(--st-running);
  }
  .wf-node.manual {
    border-left-color: var(--st-manual);
  }
  .wf-node.done {
    border-left-color: var(--st-done);
  }
  .wf-node.error {
    border-left-color: var(--st-error);
  }
  .wf-node.needs-input {
    border-left-color: var(--st-needs-input);
  }
  .wf-node.blocked,
  .wf-node.stopped,
  .wf-node.rate-limited {
    border-left-color: var(--st-stopped);
  }
  .wf-node.queued {
    border-left-color: var(--st-queued);
  }
  .wf-top {
    min-width: 0;
  }
  .wf-label {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--color-base-content);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.25;
  }
  .wf-bot {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .wf-wait {
    font-size: 10px;
    color: var(--st-stopped);
    font-weight: 600;
  }
</style>
