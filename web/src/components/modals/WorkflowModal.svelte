<script lang="ts">
  /**
   * Workflow builder — an interactive canvas of the fleet. Sessions are draggable
   * nodes; dependency (`dependsOn`) edges are arrows meaning "runs after". Drag a
   * node's right-edge handle onto another node to make that node run after this
   * one; click an edge to remove it. Node positions persist locally; the backend
   * stays the source of truth for dependencies (it re-validates cycles).
   */
  import type { SessionView } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import {
    deriveEdges,
    deriveAutomationEdges,
    layeredLayout,
    wouldCreateCycle,
    hasEdge,
    withDependency,
    withoutDependency,
  } from "../../lib/graph";
  import Modal from "../Modal.svelte";
  import StatusBadge from "../StatusBadge.svelte";
  import Icon from "../Icon.svelte";

  let sessions = $derived(wsStore.snapshot?.sessions ?? []);

  const NODE_W = 196;
  const NODE_H = 70;
  const GAP_X = 84;
  const GAP_Y = 26;
  const PAD = 16;
  const POS_KEY = "agi.wf.pos.v1";

  function label(s: SessionView): string {
    const g = (s.goal ?? "").trim().replace(/\s+/g, " ");
    return g.length > 52 ? g.slice(0, 52) + "…" : g || s.id.slice(0, 8);
  }

  // Saved (operator-dragged) positions, by session id.
  let saved = $state<Record<string, { x: number; y: number }>>(readSaved());
  function readSaved(): Record<string, { x: number; y: number }> {
    try {
      return JSON.parse(localStorage.getItem(POS_KEY) ?? "{}");
    } catch {
      return {};
    }
  }
  function persist(): void {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(saved));
    } catch {
      /* storage disabled — positions just won't persist */
    }
  }

  // Auto (layered) pixel positions — the fallback for any node not hand-placed.
  let autoPos = $derived.by(() => {
    const grid = layeredLayout(sessions);
    const out = new Map<string, { x: number; y: number }>();
    for (const [id, g] of grid) {
      out.set(id, { x: PAD + g.col * (NODE_W + GAP_X), y: PAD + g.row * (NODE_H + GAP_Y) });
    }
    return out;
  });

  /** Effective position for a node: hand-placed if present, else auto. */
  function posOf(id: string): { x: number; y: number } {
    return saved[id] ?? autoPos.get(id) ?? { x: PAD, y: PAD };
  }

  let edges = $derived(deriveEdges(sessions));
  let hasDeps = $derived(edges.length > 0);

  // Automation rules that link two concrete sessions, drawn as a distinct edge type.
  let automations = $derived(wsStore.snapshot?.automations ?? []);
  let autoEdges = $derived(deriveAutomationEdges(automations, sessions.map((s) => s.id)));

  // Canvas size grows to contain the furthest node.
  let canvasSize = $derived.by(() => {
    let w = NODE_W + PAD * 2;
    let h = NODE_H + PAD * 2;
    for (const s of sessions) {
      const p = posOf(s.id);
      w = Math.max(w, p.x + NODE_W + PAD);
      h = Math.max(h, p.y + NODE_H + PAD);
    }
    return { w, h };
  });

  // ── interaction state ────────────────────────────────────────────────────────
  let canvasEl = $state<HTMLDivElement | null>(null);
  let drag = $state<{ id: string; ox: number; oy: number; moved: boolean } | null>(null);
  let conn = $state<{ from: string; x1: number; y1: number; cx: number; cy: number } | null>(null);
  let hoverId = $state<string | null>(null);

  function local(e: PointerEvent): { x: number; y: number } {
    const r = canvasEl?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  /** Topmost node whose box (grown by a small tolerance) contains (x,y), excluding `skip`. */
  function nodeAt(x: number, y: number, skip?: string): string | null {
    const T = 10; // forgiving hit padding so a near-miss drop still lands
    let hit: string | null = null;
    for (const s of sessions) {
      if (s.id === skip) continue;
      const p = posOf(s.id);
      if (x >= p.x - T && x <= p.x + NODE_W + T && y >= p.y - T && y <= p.y + NODE_H + T) hit = s.id;
    }
    return hit;
  }

  function startDrag(e: PointerEvent, id: string): void {
    if (e.button !== 0) return;
    const p = posOf(id);
    const l = local(e);
    drag = { id, ox: l.x - p.x, oy: l.y - p.y, moved: false };
    e.preventDefault();
  }

  function startConn(e: PointerEvent, id: string): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const p = posOf(id);
    const l = local(e);
    conn = { from: id, x1: p.x + NODE_W, y1: p.y + NODE_H / 2, cx: l.x, cy: l.y };
  }

  function onMove(e: PointerEvent): void {
    if (drag) {
      const l = local(e);
      const nx = Math.max(0, l.x - drag.ox);
      const ny = Math.max(0, l.y - drag.oy);
      const cur = posOf(drag.id);
      if (!drag.moved && (Math.abs(nx - cur.x) > 4 || Math.abs(ny - cur.y) > 4)) drag.moved = true;
      saved = { ...saved, [drag.id]: { x: nx, y: ny } };
    } else if (conn) {
      const l = local(e);
      conn.cx = l.x;
      conn.cy = l.y;
      hoverId = nodeAt(l.x, l.y, conn.from);
    }
  }

  function onUp(e: PointerEvent): void {
    if (drag) {
      if (drag.moved) persist();
      else open(drag.id); // a click (no real drag) opens the session
      drag = null;
    } else if (conn) {
      const l = local(e);
      const target = nodeAt(l.x, l.y, conn.from);
      if (target) attemptConnect(conn.from, target);
      conn = null;
      hoverId = null;
    }
  }

  function attemptConnect(from: string, to: string): void {
    if (hasEdge(sessions, from, to)) {
      ui.toast("those steps are already linked");
      return;
    }
    if (wouldCreateCycle(sessions, from, to)) {
      ui.toast("can't link — that would create a dependency cycle");
      return;
    }
    wsStore.send({ type: "update", id: to, patch: { dependsOn: withDependency(sessions, from, to) } });
    ui.toast(`${shortId(to)} now runs after ${shortId(from)}`);
  }

  function removeEdge(from: string, to: string): void {
    if (!confirm(`Remove dependency — "${shortId(to)}" will no longer wait for "${shortId(from)}"?`)) return;
    wsStore.send({ type: "update", id: to, patch: { dependsOn: withoutDependency(sessions, from, to) } });
    ui.toast("dependency removed");
  }

  function shortId(id: string): string {
    const s = sessions.find((x) => x.id === id);
    return s ? (label(s).length > 24 ? label(s).slice(0, 24) + "…" : label(s)) : id;
  }

  function autoArrange(): void {
    saved = {};
    persist();
    ui.toast("auto-arranged");
  }

  function open(id: string): void {
    ui.focusId = id;
    wsStore.send({ type: "focus", id });
    ui.closeModal();
  }

  // Edge geometry from live positions (so edges follow dragged nodes).
  let edgeGeo = $derived.by(() =>
    edges.map((e) => {
      const f = posOf(e.from);
      const t = posOf(e.to);
      const blocked = !!sessions.find((s) => s.id === e.to)?.blockedBy?.includes(e.from);
      return {
        ...e,
        x1: f.x + NODE_W,
        y1: f.y + NODE_H / 2,
        x2: t.x,
        y2: t.y + NODE_H / 2,
        blocked,
      };
    }),
  );

  function path(e: { x1: number; y1: number; x2: number; y2: number }): string {
    const dx = Math.max(28, Math.abs(e.x2 - e.x1) * 0.5);
    return `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1}, ${e.x2 - dx} ${e.y2}, ${e.x2} ${e.y2}`;
  }

  // Automation edges: source's right-center → target's left-center, bowed downward
  // so they don't sit on top of dependency edges between the same pair.
  const BOW = 30;
  let autoEdgeGeo = $derived.by(() =>
    autoEdges.map((e) => {
      const f = posOf(e.from);
      const t = posOf(e.to);
      const x1 = f.x + NODE_W;
      const y1 = f.y + NODE_H / 2;
      const x2 = t.x;
      const y2 = t.y + NODE_H / 2;
      const text = `⚡ ${e.events.length ? e.events.join("/") : "any"} → ${e.kind}`;
      return {
        ...e,
        x1,
        y1,
        x2,
        y2,
        mx: (x1 + x2) / 2,
        my: (y1 + y2) / 2 + BOW,
        text,
        w: text.length * 6.1 + 12,
      };
    }),
  );

  function autoPath(e: { x1: number; y1: number; x2: number; y2: number }): string {
    const dx = Math.max(24, Math.abs(e.x2 - e.x1) * 0.4);
    return `M ${e.x1} ${e.y1} C ${e.x1 + dx} ${e.y1 + BOW}, ${e.x2 - dx} ${e.y2 + BOW}, ${e.x2} ${e.y2}`;
  }

  let hasAuto = $derived(autoEdges.length > 0);

  // Pending-connection validity (drives the live-line color + drop highlight).
  let connValid = $derived(
    conn && hoverId ? !hasEdge(sessions, conn.from, hoverId) && !wouldCreateCycle(sessions, conn.from, hoverId) : false,
  );
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} />

<Modal title="Workflow builder" width={940} onclose={() => ui.closeModal()}>
  {#if sessions.length === 0}
    <div class="wf-empty">No sessions yet — create some, then drag to connect them into a workflow.</div>
  {:else}
    <div class="wf-bar">
      <span class="wf-hint">
        Drag a node to move it. Drag the <span class="wf-dot-inline"></span> handle onto another node to make
        it <b>run after</b> this one. Click an edge to remove it.
      </span>
      <span class="wf-legend">
        <span class="lg"><span class="lg-line dep"></span> depends on</span>
        {#if hasAuto}<span class="lg"><span class="lg-line auto"></span> automation</span>{/if}
      </span>
      <button class="btn btn-xs" onclick={autoArrange} title="Reset node positions to the auto layout">
        <Icon name="layers" size={12} /> Auto-arrange
      </button>
    </div>
    {#if !hasDeps}
      <div class="wf-note">
        No dependencies yet. Connect two nodes (drag a handle) to chain them — a dependent auto-starts
        once everything it runs after has finished.
      </div>
    {/if}
    <div class="wf-scroll">
      <div
        class="wf-canvas"
        class:connecting={!!conn}
        bind:this={canvasEl}
        style="width:{canvasSize.w}px; height:{canvasSize.h}px;"
      >
        <svg class="wf-edges" width={canvasSize.w} height={canvasSize.h}>
          <defs>
            <!-- arrowhead inherits the edge's stroke colour (SVG2 context-stroke) -->
            <marker id="wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          {#each edgeGeo as e (e.from + "->" + e.to)}
            <!-- wide invisible hit-path so the thin edge is easy to click -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <path
              d={path(e)}
              class="wf-hit"
              role="button"
              tabindex="-1"
              aria-label={`Remove dependency ${e.from} to ${e.to}`}
              onclick={() => removeEdge(e.from, e.to)}
            />
            <path d={path(e)} class="wf-edge" class:blocked={e.blocked} />
          {/each}
          {#each autoEdgeGeo as e (e.ruleId + e.from + e.to + e.kind)}
            <!-- automation trigger edge — distinct dashed style + arrowhead + label -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <path
              d={autoPath(e)}
              class="wf-hit"
              role="button"
              tabindex="-1"
              aria-label={`Edit automation ${e.ruleName}`}
              onclick={() => ui.openModal({ kind: "automations" })}
            />
            <path d={autoPath(e)} class="wf-auto-edge {e.kind}" marker-end="url(#wf-arrow)" />
            <g class="wf-auto-label {e.kind}" transform="translate({e.mx},{e.my})">
              <rect x={-e.w / 2} y="-9" width={e.w} height="18" rx="9" />
              <text x="0" y="4" text-anchor="middle">{e.text}</text>
            </g>
          {/each}
          {#if conn}
            <path
              d={path({ x1: conn.x1, y1: conn.y1, x2: conn.cx, y2: conn.cy })}
              class="wf-edge pending"
              class:invalid={!!hoverId && !connValid}
            />
          {/if}
        </svg>
        {#each sessions as s (s.id)}
          {@const p = posOf(s.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="wf-node {s.status}"
            class:focused={s.id === ui.focusId}
            class:droptarget={conn && hoverId === s.id}
            class:dropok={conn && hoverId === s.id && connValid}
            style="left:{p.x}px; top:{p.y}px; width:{NODE_W}px; height:{NODE_H}px;"
            title={s.goal}
            onpointerdown={(e) => startDrag(e, s.id)}
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
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              class="wf-handle"
              title="Drag onto a session that should run AFTER this one"
              onpointerdown={(e) => startConn(e, s.id)}
            ></span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</Modal>

<style>
  .wf-empty {
    color: var(--faint);
    font-size: 13px;
    text-align: center;
    padding: 28px;
  }
  .wf-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }
  .wf-hint {
    font-size: 12px;
    color: var(--color-neutral-content);
    line-height: 1.5;
    flex: 1;
  }
  .wf-dot-inline {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-primary);
    vertical-align: middle;
  }
  .wf-legend {
    display: flex;
    gap: 12px;
    flex: none;
    font-size: 11px;
    color: var(--faint);
  }
  .wf-legend .lg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .lg-line {
    display: inline-block;
    width: 16px;
    height: 0;
    border-top-width: 2px;
    border-top-style: solid;
  }
  .lg-line.dep {
    border-top-color: var(--st-done, #60a5fa);
  }
  .lg-line.auto {
    border-top-style: dashed;
    border-top-color: var(--st-running);
  }
  .wf-note {
    color: var(--faint);
    font-size: 13px;
    line-height: 1.5;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    padding: 9px 12px;
    margin-bottom: 12px;
  }
  .wf-scroll {
    overflow: auto;
    max-height: 62vh;
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    background:
      radial-gradient(circle at 1px 1px, var(--border-soft) 1px, transparent 0) 0 0 / 22px 22px;
  }
  .wf-canvas {
    position: relative;
    touch-action: none;
  }
  .wf-canvas.connecting {
    cursor: crosshair;
  }
  .wf-edges {
    position: absolute;
    inset: 0;
    overflow: visible;
  }
  .wf-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 14;
    cursor: pointer;
    pointer-events: stroke;
  }
  .wf-edge {
    fill: none;
    stroke: var(--st-done, #60a5fa);
    stroke-width: 2;
    opacity: 0.55;
    pointer-events: none;
  }
  .wf-hit:hover + .wf-edge {
    opacity: 1;
    stroke-width: 2.6;
  }
  .wf-edge.blocked {
    stroke: var(--st-stopped, #fbbf24);
    stroke-dasharray: 5 4;
    opacity: 0.85;
  }
  .wf-edge.pending {
    stroke: var(--color-primary);
    opacity: 0.9;
    stroke-dasharray: 6 4;
  }
  .wf-edge.pending.invalid {
    stroke: var(--st-error);
  }
  /* automation trigger edges — dashed + arrowhead + coloured by action */
  .wf-auto-edge {
    fill: none;
    stroke-width: 2;
    stroke-dasharray: 2 5;
    stroke-linecap: round;
    opacity: 0.9;
    pointer-events: none;
  }
  .wf-auto-edge.start {
    stroke: var(--st-running);
  }
  .wf-auto-edge.stop {
    stroke: var(--st-error);
  }
  .wf-auto-label {
    pointer-events: none;
  }
  .wf-auto-label rect {
    fill: var(--color-base-100);
    stroke-width: 1;
  }
  .wf-auto-label.start rect {
    stroke: var(--st-running);
  }
  .wf-auto-label.stop rect {
    stroke: var(--st-error);
  }
  .wf-auto-label text {
    font-size: 10px;
    font-weight: 600;
    fill: var(--color-base-content);
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
    cursor: grab;
    user-select: none;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .wf-node:active {
    cursor: grabbing;
  }
  .wf-node:hover {
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
  }
  .wf-node.focused {
    box-shadow: 0 0 0 2px var(--color-primary);
  }
  .wf-node.droptarget {
    box-shadow: 0 0 0 2px var(--st-error);
  }
  .wf-node.dropok {
    box-shadow: 0 0 0 2px var(--color-primary);
  }
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
    pointer-events: none;
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
    pointer-events: none;
  }
  .wf-wait {
    font-size: 10px;
    color: var(--st-stopped);
    font-weight: 600;
  }
  .wf-handle {
    position: absolute;
    right: -8px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--color-primary);
    border: 2px solid var(--color-base-100);
    cursor: crosshair;
    opacity: 0.6;
    transition: opacity 0.15s, transform 0.1s;
  }
  /* Invisible larger grab target so the handle is easy to start a link from. */
  .wf-handle::before {
    content: "";
    position: absolute;
    inset: -8px;
    border-radius: 50%;
  }
  .wf-node:hover .wf-handle {
    opacity: 1;
  }
  .wf-handle:hover {
    transform: translateY(-50%) scale(1.25);
  }
</style>
