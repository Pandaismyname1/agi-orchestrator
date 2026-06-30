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
    hasAutomationEdge,
    layeredLayout,
    wouldCreateCycle,
    hasEdge,
    withDependency,
    withoutDependency,
    clampZoom,
    stepZoom,
    fitScale,
    ZOOM_MIN,
    ZOOM_MAX,
  } from "../../lib/graph";
  import { buildSessionDraft, type DraftMode } from "../../lib/nodeform";
  import { DRAW_EVENTS, defaultEventFor, buildDrawnAutomation, eventPhrase } from "../../lib/drawauto";
  import { loadWorkflowPrefs, saveWorkflowPrefs, type LinkMode } from "../../lib/wfprefs";
  import type { WebhookEvent } from "../../lib/types";
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
  const ZOOM_KEY = "agi.wf.zoom.v1";

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

  // ── pan & zoom ────────────────────────────────────────────────────────────────
  // Pan is the scroll container's native overflow; zoom scales the canvas via a
  // CSS transform, with a sizer element so the scroll extent tracks the zoom.
  let scrollEl = $state<HTMLDivElement | null>(null);
  let zoom = $state<number>(readZoom());
  function readZoom(): number {
    try {
      return clampZoom(Number(localStorage.getItem(ZOOM_KEY)) || 1);
    } catch {
      return 1;
    }
  }
  function persistZoom(): void {
    try {
      localStorage.setItem(ZOOM_KEY, String(zoom));
    } catch {
      /* storage disabled — zoom just won't persist */
    }
  }
  function setZoom(z: number): void {
    zoom = clampZoom(z);
    persistZoom();
  }
  function zoomBy(dir: number): void {
    setZoom(stepZoom(zoom, dir));
  }
  function resetZoom(): void {
    setZoom(1);
  }
  function fitView(): void {
    if (!scrollEl) return;
    setZoom(fitScale(canvasSize.w, canvasSize.h, scrollEl.clientWidth, scrollEl.clientHeight));
  }
  function onWheel(e: WheelEvent): void {
    // Ctrl/⌘ + wheel zooms (like a map); plain wheel scrolls (native).
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }

  // ── interaction state ────────────────────────────────────────────────────────
  let canvasEl = $state<HTMLDivElement | null>(null);
  let drag = $state<{ id: string; ox: number; oy: number; moved: boolean } | null>(null);
  let conn = $state<{ from: string; x1: number; y1: number; cx: number; cy: number } | null>(null);
  let hoverId = $state<string | null>(null);

  // What a handle-drag creates: a dependency, or an automation (start/stop) rule.
  // Both the mode and the trigger event are seeded from the operator's last choice
  // (persisted to localStorage) so the toolbar remembers preferences across sessions.
  const initialPrefs = loadWorkflowPrefs();
  let linkMode = $state<LinkMode>(initialPrefs.linkMode);
  const LINK_MODES: { id: LinkMode; label: string; icon: "chevronRight" | "play" | "stop" }[] = [
    { id: "depends", label: "Depends on", icon: "chevronRight" },
    { id: "start", label: "Start", icon: "play" },
    { id: "stop", label: "Stop", icon: "stop" },
  ];
  // Trigger event a drawn start/stop edge fires on (operator-pickable; seeded with
  // the sensible default when the action mode changes).
  let drawEvent = $state<WebhookEvent>(initialPrefs.drawEvent);
  function pickMode(m: LinkMode): void {
    linkMode = m;
    if (m !== "depends") drawEvent = defaultEventFor(m);
  }
  // Persist the toolbar choice whenever it changes (covers pickMode + the event select).
  $effect(() => {
    saveWorkflowPrefs({ linkMode, drawEvent });
  });

  // Drop-to-create a session node: a "+ Session" chip drags a ghost; dropping on
  // the canvas opens a tiny inline create card at that point.
  let placing = $state<{ sx: number; sy: number } | null>(null);
  let creating = $state<{ x: number; y: number } | null>(null);
  let nGoal = $state("");
  let nCwd = $state("");
  let nDone = $state("");
  let nMode = $state<DraftMode>("autopilot");
  let nErr = $state("");

  function local(e: PointerEvent): { x: number; y: number } {
    // canvasEl carries the zoom transform, so its bounding rect is in screen px;
    // divide by zoom to get untransformed canvas-space coordinates.
    const r = canvasEl?.getBoundingClientRect();
    return { x: (e.clientX - (r?.left ?? 0)) / zoom, y: (e.clientY - (r?.top ?? 0)) / zoom };
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

  function startPlace(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    placing = { sx: e.clientX, sy: e.clientY };
  }

  function onMove(e: PointerEvent): void {
    if (placing) {
      placing = { sx: e.clientX, sy: e.clientY };
      return;
    }
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
    if (placing) {
      const l = local(e);
      const inside = l.x >= 0 && l.y >= 0 && l.x <= canvasSize.w && l.y <= canvasSize.h;
      placing = null;
      if (inside) {
        // Centre the new node on the drop point, clamped into the canvas.
        nGoal = "";
        nCwd = "";
        nDone = "";
        nMode = "autopilot";
        nErr = "";
        creating = { x: Math.max(0, l.x - NODE_W / 2), y: Math.max(0, l.y - NODE_H / 2) };
      }
      return;
    }
    if (drag) {
      if (drag.moved) persist();
      else open(drag.id); // a click (no real drag) opens the session
      drag = null;
    } else if (conn) {
      const l = local(e);
      const target = nodeAt(l.x, l.y, conn.from);
      if (target) {
        if (linkMode === "depends") attemptConnect(conn.from, target);
        else attemptAutomation(conn.from, target, linkMode);
      }
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

  /**
   * Create an automation rule by drawing: "when FROM fires <drawEvent>, <kind> TO".
   * The trigger event is operator-pickable (defaults: start-on-done forward
   * chaining, stop-on-error halt-on-break). Editable afterward in the Automations
   * manager.
   */
  function attemptAutomation(from: string, to: string, kind: "start" | "stop"): void {
    if (hasAutomationEdge(automations, from, to, kind)) {
      ui.toast(`that ${kind} automation already exists`);
      return;
    }
    const event = drawEvent;
    const automation = buildDrawnAutomation({
      from,
      to,
      kind,
      event,
      fromLabel: shortId(from),
      toLabel: shortId(to),
    });
    wsStore.send({ type: "automationSave", automation });
    ui.toast(`automation added — ${kind} ${shortId(to)} on ${shortId(from)} ${event}`);
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

  function cancelCreate(): void {
    creating = null;
    nErr = "";
  }

  /** Create the dropped session node: client id lets us place it at the drop point now. */
  function createNode(): void {
    if (!creating) return;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `wf-${nGoal.trim().slice(0, 8) || "node"}-${nCwd.length}`;
    const res = buildSessionDraft({ id, cwd: nCwd, goal: nGoal, doneCriteria: nDone, mode: nMode });
    if (!res.ok) {
      nErr = res.error;
      return;
    }
    saved = { ...saved, [id]: { x: creating.x, y: creating.y } };
    persist();
    wsStore.send({
      type: "add",
      session: {
        id,
        cwd: res.draft.cwd,
        goal: res.draft.goal,
        doneCriteria: res.draft.doneCriteria,
        startMode: res.draft.startMode,
      },
    });
    ui.toast(`session node added — ${res.draft.goal.slice(0, 32)}`);
    creating = null;
  }

  function open(id: string): void {
    ui.focusId = id;
    wsStore.send({ type: "focus", id });
    ui.closeModal();
  }

  /**
   * Delete a session node from the canvas. Captures its full config + position
   * first so the deletion can be undone (re-added with the same id, which also
   * restores any dependency edges that pointed at it — dependents keep their
   * dependsOn entries). Only blocks while the session is actively running, which
   * is the one case the backend rejects.
   */
  function delNode(s: SessionView, e: MouseEvent): void {
    e.stopPropagation();
    if (s.status === "running") {
      ui.toast("stop the session before deleting it");
      return;
    }
    const snap = { ...s };
    const pos = posOf(s.id);
    const name = label(s);
    wsStore.send({ type: "remove", id: s.id });
    ui.toast(`deleted "${name}"`, { label: "Undo", run: () => undoDelete(snap, pos, name) });
  }

  /** Re-create a just-deleted session node with its prior config + canvas position. */
  function undoDelete(snap: SessionView, pos: { x: number; y: number }, name: string): void {
    saved = { ...saved, [snap.id]: pos };
    persist();
    wsStore.send({
      type: "add",
      session: {
        id: snap.id,
        cwd: snap.cwd,
        goal: snap.goal,
        doneCriteria: snap.doneCriteria,
        permissionMode: snap.permissionMode,
        autonomy: snap.autonomy,
        startMode: snap.mode,
        dependsOn: snap.dependsOn,
        schedule: snap.schedule,
        autoPr: snap.autoPr,
      },
    });
    ui.toast(`restored "${name}"`);
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

  // Pending-connection validity (drives the live-line color + drop highlight),
  // evaluated against the active link mode.
  let connValid = $derived.by(() => {
    if (!conn || !hoverId) return false;
    if (linkMode === "depends") {
      return !hasEdge(sessions, conn.from, hoverId) && !wouldCreateCycle(sessions, conn.from, hoverId);
    }
    return !hasAutomationEdge(automations, conn.from, hoverId, linkMode);
  });
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} />

<Modal title="Workflow builder" width={940} onclose={() => ui.closeModal()}>
  {#if sessions.length === 0}
    <div class="wf-empty">No sessions yet — create some, then drag to connect them into a workflow.</div>
  {:else}
    <div class="wf-bar">
      <span class="wf-hint">
        Drag a node to move it. Drag the <span class="wf-dot-inline" class:start={linkMode === "start"} class:stop={linkMode === "stop"}></span>
        handle onto another node to
        {#if linkMode === "depends"}make it <b>run after</b> this one{:else if linkMode === "start"}<b>start</b> it when this {eventPhrase(drawEvent)}{:else}<b>stop</b> it when this {eventPhrase(drawEvent)}{/if}.
        Click an edge to remove it.
      </span>
      <span class="wf-modes" role="group" aria-label="What a connection creates">
        {#each LINK_MODES as m (m.id)}
          <button
            class="wf-mode {m.id}"
            class:on={linkMode === m.id}
            aria-pressed={linkMode === m.id}
            title={m.id === "depends" ? "Draw a dependency (runs after)" : `Draw an automation (${m.id})`}
            onclick={() => pickMode(m.id)}
          >
            <Icon name={m.icon} size={12} /> {m.label}
          </button>
        {/each}
      </span>
      {#if linkMode !== "depends"}
        <label class="wf-evt" title="Trigger event for the automation you draw">
          on
          <select bind:value={drawEvent} aria-label="Trigger event">
            {#each DRAW_EVENTS as ev (ev)}
              <option value={ev}>{ev}</option>
            {/each}
          </select>
        </label>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="wf-newchip"
        title="Drag onto the canvas to add a session node"
        onpointerdown={startPlace}
      >
        <Icon name="plus" size={12} /> Session
      </div>
      <span class="wf-zoom" role="group" aria-label="Zoom">
        <button class="wf-zbtn" title="Zoom out" aria-label="Zoom out" onclick={() => zoomBy(-1)} disabled={zoom <= ZOOM_MIN}>−</button>
        <button class="wf-zlevel" title="Reset zoom to 100%" aria-label="Reset zoom" onclick={resetZoom}>{Math.round(zoom * 100)}%</button>
        <button class="wf-zbtn" title="Zoom in" aria-label="Zoom in" onclick={() => zoomBy(1)} disabled={zoom >= ZOOM_MAX}>+</button>
        <button class="wf-zbtn wf-zfit" title="Fit to view" aria-label="Fit to view" onclick={fitView}><Icon name="search" size={12} /></button>
      </span>
      <button class="btn btn-xs" onclick={autoArrange} title="Reset node positions to the auto layout">
        <Icon name="layers" size={12} /> Auto-arrange
      </button>
    </div>
    {#if hasDeps || hasAuto}
      <div class="wf-legend">
        <span class="lg"><span class="lg-line dep"></span> depends on</span>
        {#if hasAuto}<span class="lg"><span class="lg-line auto"></span> automation</span>{/if}
      </div>
    {/if}
    {#if !hasDeps}
      <div class="wf-note">
        No dependencies yet. Connect two nodes (drag a handle) to chain them — a dependent auto-starts
        once everything it runs after has finished.
      </div>
    {/if}
    <div class="wf-scroll" bind:this={scrollEl} onwheel={onWheel}>
      <div class="wf-sizer" style="width:{canvasSize.w * zoom}px; height:{canvasSize.h * zoom}px;">
      <div
        class="wf-canvas"
        class:connecting={!!conn}
        bind:this={canvasEl}
        style="width:{canvasSize.w}px; height:{canvasSize.h}px; transform: scale({zoom}); transform-origin: 0 0;"
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
              class="wf-edge pending {linkMode}"
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
            <button
              class="wf-del"
              title="Delete this session node"
              aria-label={`Delete ${s.id}`}
              onpointerdown={(e) => e.stopPropagation()}
              onclick={(e) => delNode(s, e)}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        {/each}

        {#if creating}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="wf-create"
            style="left:{creating.x}px; top:{creating.y}px;"
            onpointerdown={(e) => e.stopPropagation()}
          >
            <div class="wf-create-h">New session node</div>
            <input bind:value={nGoal} placeholder="Goal (what it should do)" aria-label="Goal" />
            <input bind:value={nCwd} placeholder="Working directory (cwd)" aria-label="Working directory" />
            <input bind:value={nDone} placeholder="Done when… (optional)" aria-label="Done criteria" />
            <select bind:value={nMode} aria-label="Start mode">
              <option value="autopilot">autopilot</option>
              <option value="manual">manual</option>
            </select>
            {#if nErr}<div class="wf-create-err">{nErr}</div>{/if}
            <div class="wf-create-foot">
              <button class="btn btn-xs" onclick={cancelCreate}>Cancel</button>
              <button class="btn btn-xs btn-primary" onclick={createNode}>Create</button>
            </div>
          </div>
        {/if}
      </div>
      </div>
    </div>
  {/if}
</Modal>

{#if placing}
  <div class="wf-ghost" style="left:{placing.sx}px; top:{placing.sy}px;">
    <Icon name="plus" size={12} /> Session
  </div>
{/if}

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
    margin-bottom: 8px;
    flex-wrap: wrap;
  }
  .wf-hint {
    font-size: 12px;
    color: var(--color-neutral-content);
    line-height: 1.5;
    flex: 1;
    min-width: 240px;
  }
  .wf-dot-inline {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--color-primary);
    vertical-align: middle;
  }
  .wf-dot-inline.start {
    background: var(--st-running);
  }
  .wf-dot-inline.stop {
    background: var(--st-error);
  }
  /* link-mode segmented control */
  .wf-modes {
    display: inline-flex;
    flex: none;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    overflow: hidden;
  }
  .wf-mode {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-size: 11.5px;
    padding: 5px 9px;
    border: none;
    border-right: 1px solid var(--border-soft);
    background: var(--color-base-200);
    color: var(--color-neutral-content);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .wf-mode:last-child {
    border-right: none;
  }
  .wf-mode:hover {
    color: var(--color-base-content);
  }
  .wf-mode.on.depends {
    background: rgba(96, 165, 250, 0.16);
    color: var(--st-done);
  }
  .wf-mode.on.start {
    background: rgba(34, 197, 94, 0.16);
    color: var(--st-running);
  }
  .wf-mode.on.stop {
    background: rgba(248, 113, 113, 0.16);
    color: var(--st-error);
  }
  .wf-evt {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    font-size: 11.5px;
    color: var(--color-neutral-content);
  }
  .wf-evt select {
    font: inherit;
    font-size: 11.5px;
    color: var(--color-base-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    padding: 4px 6px;
    cursor: pointer;
  }
  .wf-evt select:focus {
    outline: none;
    border-color: var(--color-primary);
  }
  .wf-legend {
    display: flex;
    gap: 12px;
    flex: none;
    font-size: 11px;
    color: var(--faint);
    margin-bottom: 10px;
  }
  /* draggable "+ Session" chip */
  .wf-newchip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: 8px;
    border: 1px dashed var(--color-primary);
    background: rgba(34, 197, 94, 0.08);
    color: var(--color-primary);
    cursor: grab;
    user-select: none;
    touch-action: none;
  }
  .wf-newchip:active {
    cursor: grabbing;
  }
  .wf-ghost {
    position: fixed;
    transform: translate(8px, 8px);
    z-index: 70;
    pointer-events: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11.5px;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: 8px;
    border: 1px dashed var(--color-primary);
    background: var(--color-base-100);
    color: var(--color-primary);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  /* inline create card on the canvas */
  .wf-create {
    position: absolute;
    z-index: 5;
    width: 230px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
    border-radius: 11px;
    background: var(--color-base-100);
    border: 1px solid var(--color-primary);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
  .wf-create-h {
    font-size: 12px;
    font-weight: 700;
    color: var(--color-base-content);
  }
  .wf-create input,
  .wf-create select {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-size: 12px;
    color: var(--color-base-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    padding: 6px 8px;
  }
  .wf-create input:focus,
  .wf-create select:focus {
    outline: none;
    border-color: var(--color-primary);
  }
  .wf-create-err {
    font-size: 11px;
    color: var(--color-error);
  }
  .wf-create-foot {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 2px;
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
  .wf-sizer {
    position: relative;
  }
  .wf-canvas {
    position: relative;
    touch-action: none;
  }
  /* zoom control cluster */
  .wf-zoom {
    display: inline-flex;
    flex: none;
    align-items: stretch;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    overflow: hidden;
  }
  .wf-zbtn,
  .wf-zlevel {
    font: inherit;
    font-size: 12px;
    border: none;
    border-right: 1px solid var(--border-soft);
    background: var(--color-base-200);
    color: var(--color-neutral-content);
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .wf-zbtn {
    width: 26px;
    display: inline-grid;
    place-items: center;
  }
  .wf-zlevel {
    min-width: 46px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .wf-zoom button:last-child {
    border-right: none;
  }
  .wf-zbtn:hover:not(:disabled),
  .wf-zlevel:hover {
    color: var(--color-base-content);
    background: var(--color-base-300);
  }
  .wf-zbtn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .wf-zfit {
    color: var(--color-primary);
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
  .wf-edge.pending.start {
    stroke: var(--st-running);
  }
  .wf-edge.pending.stop {
    stroke: var(--st-error);
  }
  .wf-edge.pending.invalid {
    stroke: var(--st-error);
    opacity: 0.6;
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
  .wf-del {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: var(--color-base-200);
    color: var(--color-neutral-content);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, color 0.12s, border-color 0.12s, background 0.12s;
  }
  .wf-node:hover .wf-del {
    opacity: 1;
  }
  .wf-del:hover {
    color: var(--color-error);
    border-color: var(--color-error);
    background: rgba(248, 113, 113, 0.12);
  }
</style>
