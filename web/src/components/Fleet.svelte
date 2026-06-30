<script lang="ts">
  import type { SessionView } from "../lib/types";
  import { SvelteSet } from "svelte/reactivity";
  import { ui } from "../lib/ui.svelte";
  import { wsStore } from "../lib/ws.svelte";
  import { filterSessions } from "../lib/filter";
  import { sortSessions, SORT_OPTIONS, type SortKey } from "../lib/sort";
  import { actionableIds } from "../lib/selection";
  import Icon from "./Icon.svelte";
  import AgentCard from "./AgentCard.svelte";
  import AttachedPanel from "./AttachedPanel.svelte";

  interface Props {
    sessions: SessionView[];
  }
  let { sessions }: Props = $props();

  let attached = $derived(wsStore.snapshot?.attached ?? []);

  // Fleet search: a debounced query filters the list (id/goal/cwd/status/mode/…).
  let query = $state("");
  let debounced = $state("");
  $effect(() => {
    const q = query;
    const t = setTimeout(() => (debounced = q), 150);
    return () => clearTimeout(t);
  });
  // Sort key applies AFTER filtering. Default "attention" floats sessions that
  // need a human (error/needs-input/blocked) to the top of the list.
  let sortKey = $state<SortKey>("attention");
  let filtered = $derived(sortSessions(filterSessions(sessions, debounced), sortKey));
  let filtering = $derived(debounced.trim().length > 0);

  // Bulk multi-select. Selection persists across snapshots; cleared on exit.
  let selectMode = $state(false);
  let selected = $state(new SvelteSet<string>());
  let startable = $derived(actionableIds(filtered, selected, "start"));
  let stoppable = $derived(actionableIds(filtered, selected, "stop"));

  function toggleSelect(id: string): void {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }
  function toggleSelectMode(): void {
    selectMode = !selectMode;
    if (!selectMode) selected.clear();
  }
  function selectAllFiltered(): void {
    for (const s of filtered) selected.add(s.id);
  }
  function clearSelection(): void {
    selected.clear();
  }
  function bulk(action: "start" | "stop"): void {
    const ids = action === "start" ? startable : stoppable;
    for (const id of ids) wsStore.send({ type: action, id });
    selected.clear();
  }

  // Compact status breakdown shown under the section title.
  const BREAKDOWN: { key: string; label: string; match: (s: SessionView) => boolean }[] = [
    { key: "running", label: "running", match: (s) => s.status === "running" || s.status === "manual" },
    { key: "error", label: "error", match: (s) => s.status === "error" },
    { key: "needs-input", label: "needs you", match: (s) => s.status === "needs-input" },
    { key: "blocked", label: "blocked", match: (s) => s.status === "blocked" },
    { key: "queued", label: "queued", match: (s) => s.status === "queued" },
    { key: "done", label: "done", match: (s) => s.status === "done" },
  ];
  let counts = $derived(
    BREAKDOWN.map((b) => ({ ...b, n: sessions.filter(b.match).length })).filter((b) => b.n > 0),
  );

  function focus(id: string) {
    ui.focusId = id;
    wsStore.send({ type: "focus", id });
  }
</script>

<aside class="fleet" class:collapsed={ui.fleetCollapsed}>
  <!-- Collapsed: a thin rail of status dots so fleet health stays visible
       while the content area gets the space. -->
  <div class="rail">
    <button class="iconbtn" title="Expand fleet" aria-label="Expand fleet panel" onclick={() => ui.toggleFleet()}>
      <Icon name="chevronRight" size={16} />
    </button>
    <span class="railcount tnum" title="{sessions.length} sessions">{sessions.length}</span>
    <div class="dots">
      {#each sessions as s (s.id)}
        <button
          class="dot {s.status}"
          class:sel={s.id === ui.focusId}
          title="{s.id} — {s.status}"
          aria-label="Focus {s.id} ({s.status})"
          onclick={() => focus(s.id)}
        ></button>
      {/each}
    </div>
    {#if attached.length}
      <button
        class="railplug"
        title="{attached.length} attached session{attached.length === 1 ? '' : 's'} — expand to manage"
        aria-label="{attached.length} attached sessions"
        onclick={() => ui.toggleFleet()}
      >
        <Icon name="plug" size={14} />
        <span class="tnum">{attached.length}</span>
      </button>
    {/if}
  </div>

  <!-- Expanded: full fleet list. -->
  <div class="full">
    <div class="head">
      <span class="title">Fleet</span>
      <span class="count tnum">{filtering ? `${filtered.length}/${sessions.length}` : sessions.length}</span>
      {#if sessions.length > 0}
        <button
          class="iconbtn"
          class:on={selectMode}
          title={selectMode ? "Exit selection" : "Select multiple"}
          aria-label={selectMode ? "Exit selection mode" : "Select multiple sessions"}
          aria-pressed={selectMode}
          onclick={toggleSelectMode}
        >
          <Icon name="check" size={15} />
        </button>
      {/if}
      <button class="iconbtn collapse" title="Collapse fleet" aria-label="Collapse fleet panel" onclick={() => ui.toggleFleet()}>
        <Icon name="chevronLeft" size={16} />
      </button>
    </div>

    {#if selectMode}
      <div class="bulkbar">
        <span class="bulkn"><b>{selected.size}</b> selected</span>
        <button class="btn btn-xs" onclick={selectAllFiltered} title="Select all shown">All</button>
        <button class="btn btn-xs" onclick={clearSelection} disabled={selected.size === 0}>None</button>
        <span class="bulkspace"></span>
        <button class="btn btn-xs btn-primary" onclick={() => bulk("start")} disabled={startable.length === 0} title="Start selected">
          <Icon name="play" size={11} /> Start{startable.length ? ` ${startable.length}` : ""}
        </button>
        <button class="btn btn-xs" onclick={() => bulk("stop")} disabled={stoppable.length === 0} title="Stop selected">
          <Icon name="stop" size={11} /> Stop{stoppable.length ? ` ${stoppable.length}` : ""}
        </button>
      </div>
    {/if}

    {#if sessions.length > 0}
      <div class="controls">
        <div class="search">
          <Icon name="search" size={13} />
          <input
            type="text"
            placeholder="Filter by name, status, type…"
            bind:value={query}
            aria-label="Filter sessions"
            autocomplete="off"
            spellcheck="false"
          />
          {#if query}
            <button class="clear" title="Clear filter" aria-label="Clear filter" onclick={() => (query = "")}>
              <Icon name="x" size={13} />
            </button>
          {/if}
        </div>
        <label class="sort" title="Sort the fleet list">
          <Icon name="sort" size={13} />
          <select bind:value={sortKey} aria-label="Sort sessions">
            {#each SORT_OPTIONS as o (o.key)}
              <option value={o.key}>{o.label}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}

    {#if counts.length}
      <div class="breakdown">
        {#each counts as c (c.key)}
          <span class="chip {c.key}"><b class="tnum">{c.n}</b> {c.label}</span>
        {/each}
      </div>
    {/if}

    {#if sessions.length === 0}
      <div class="onboard">
        <span class="ob-mark"><Icon name="bot" size={26} /></span>
        <h3>Mission control is empty</h3>
        <p>Create a session to put an agent to work, or adopt one you already started in Claude Code.</p>
        <div class="ob-acts">
          <button class="btn btn-primary btn-sm" onclick={() => ui.openModal({ kind: "new" })}>
            <Icon name="plus" size={13} /> New session
          </button>
          <button class="btn btn-sm" onclick={() => ui.openModal({ kind: "adopt" })}>
            <Icon name="download" size={13} /> Adopt existing
          </button>
        </div>
      </div>
    {:else if filtering && filtered.length === 0}
      <div class="nomatch">
        <Icon name="search" size={20} />
        <p>No sessions match “{debounced}”.</p>
        <button class="btn btn-sm" onclick={() => (query = "")}>Clear filter</button>
      </div>
    {:else}
      <div class="stack">
        {#each filtered as s (s.id)}
          <AgentCard
            session={s}
            selected={s.id === ui.focusId}
            {selectMode}
            checked={selected.has(s.id)}
            onToggleSelect={() => toggleSelect(s.id)}
          />
        {/each}
      </div>
    {/if}

    {#if attached.length}
      <AttachedPanel {attached} />
    {/if}
  </div>
</aside>

<style>
  .fleet {
    --fleet-w: 304px;
    flex: none;
    width: var(--fleet-w);
    height: 100%;
    border-right: 1px solid var(--border-soft);
    background: var(--color-base-100);
    display: flex;
    flex-direction: column;
    min-height: 0;
    transition: width 0.2s ease;
  }
  .fleet.collapsed {
    --fleet-w: 56px;
  }

  /* --- rail (collapsed) --- */
  .rail {
    display: none;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 12px 0;
    overflow-y: auto;
  }
  .fleet.collapsed .rail {
    display: flex;
  }
  .fleet.collapsed .full {
    display: none;
  }
  .railcount {
    font-size: 11px;
    color: var(--faint);
    font-weight: 700;
  }
  .railplug {
    margin-top: auto;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 6px 0;
    border: none;
    background: transparent;
    color: var(--color-neutral-content);
    cursor: pointer;
    font-size: 10px;
    transition: color 0.15s;
  }
  .railplug:hover {
    color: var(--color-base-content);
  }
  .dots {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: 2px;
  }
  .dot {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: var(--st-idle);
    padding: 0;
    cursor: pointer;
    transition: transform 0.1s ease, box-shadow 0.15s ease;
  }
  .dot:hover {
    transform: scale(1.18);
  }
  .dot.sel {
    box-shadow: 0 0 0 2px var(--color-base-100), 0 0 0 3px var(--color-primary);
  }
  .dot.running,
  .dot.manual {
    background: var(--st-running);
  }
  .dot.done {
    background: var(--st-done);
  }
  .dot.queued {
    background: var(--st-queued);
  }
  .dot.stopped,
  .dot.rate-limited,
  .dot.blocked {
    background: var(--st-stopped);
  }
  .dot.needs-input {
    background: var(--st-needs-input);
    animation: dotpulse 1.4s ease-in-out infinite;
  }
  .dot.error {
    background: var(--st-error);
    animation: dotpulse 1.15s ease-in-out infinite;
  }
  @keyframes dotpulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 rgba(251, 191, 36, 0);
    }
    50% {
      box-shadow: 0 0 7px 1px currentColor;
    }
  }

  /* --- full panel (expanded) --- */
  .full {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 13px 12px 9px 16px;
  }
  .title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.4px;
    color: var(--color-neutral-content);
    font-weight: 600;
  }
  .count {
    font-size: 11px;
    color: var(--faint);
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 20px;
    padding: 1px 8px;
  }
  .iconbtn {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    border: 1px solid var(--border-soft);
    background: var(--color-base-200);
    color: var(--color-neutral-content);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .iconbtn:hover {
    color: var(--color-base-content);
    border-color: var(--border-strong);
  }
  .collapse {
    margin-left: auto;
  }
  .iconbtn.on {
    color: var(--color-primary);
    border-color: rgba(34, 197, 94, 0.5);
    background: rgba(34, 197, 94, 0.1);
  }
  .bulkbar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 16px 10px;
    padding: 7px 9px;
    border: 1px solid rgba(34, 197, 94, 0.35);
    border-radius: 9px;
    background: rgba(34, 197, 94, 0.06);
  }
  .bulkn {
    font-size: 11.5px;
    color: var(--color-neutral-content);
  }
  .bulkn b {
    color: var(--color-base-content);
    font-weight: 700;
  }
  .bulkspace {
    flex: 1;
  }
  .controls {
    display: flex;
    align-items: stretch;
    gap: 7px;
    margin: 0 16px 10px;
  }
  .search {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    background: var(--color-base-200);
    color: var(--faint);
  }
  .sort {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 8px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    background: var(--color-base-200);
    color: var(--faint);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .sort:hover,
  .sort:focus-within {
    color: var(--color-neutral-content);
    border-color: var(--border-strong);
  }
  .sort select {
    border: none;
    background: transparent;
    color: var(--color-base-content);
    font: inherit;
    font-size: 12px;
    outline: none;
    cursor: pointer;
    padding: 6px 0;
    -webkit-appearance: none;
    appearance: none;
  }
  .sort select option {
    background: var(--color-base-200);
    color: var(--color-base-content);
  }
  .search:focus-within {
    border-color: var(--color-primary);
    color: var(--color-neutral-content);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--color-base-content);
    font: inherit;
    font-size: 12.5px;
    outline: none;
    padding: 0;
  }
  .search .clear {
    display: inline-grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--faint);
    cursor: pointer;
    padding: 0;
  }
  .search .clear:hover {
    color: var(--color-base-content);
  }
  .nomatch {
    text-align: center;
    padding: 28px 16px;
    color: var(--color-neutral-content);
  }
  .nomatch p {
    margin: 10px 0 14px;
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }
  .breakdown {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding: 0 16px 10px;
  }
  .chip {
    font-size: 11px;
    color: var(--color-neutral-content);
    padding: 1px 8px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
  }
  .chip b {
    font-weight: 700;
    color: var(--color-base-content);
  }
  .chip.running {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.35);
  }
  .chip.running b {
    color: var(--st-running);
  }
  .chip.needs-input {
    color: var(--st-needs-input);
    border-color: rgba(251, 191, 36, 0.45);
    background: rgba(251, 191, 36, 0.07);
  }
  .chip.needs-input b {
    color: var(--st-needs-input);
  }
  .chip.queued {
    color: var(--st-queued);
    border-color: rgba(96, 165, 250, 0.35);
  }
  .chip.blocked {
    color: var(--st-stopped);
    border-color: rgba(251, 191, 36, 0.4);
    background: rgba(251, 191, 36, 0.06);
  }
  .chip.blocked b {
    color: var(--st-stopped);
  }
  .chip.error {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.5);
    background: rgba(248, 113, 113, 0.08);
  }
  .chip.error b {
    color: var(--st-error);
  }
  .stack {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 2px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .onboard {
    text-align: center;
    padding: 28px 16px;
  }
  .ob-mark {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    display: inline-grid;
    place-items: center;
    color: var(--color-primary);
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    margin-bottom: 14px;
  }
  .onboard h3 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 700;
    color: var(--color-base-content);
  }
  .onboard p {
    margin: 0 0 16px;
    font-size: 12.5px;
    color: var(--color-neutral-content);
    line-height: 1.5;
  }
  .ob-acts {
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .fleet {
      transition: none;
    }
  }

  /* Mobile: full-width stacked list (the collapse rail is a desktop affordance). */
  @media (max-width: 720px) {
    .fleet,
    .fleet.collapsed {
      width: auto;
      height: auto;
      border-right: none;
      border-bottom: 1px solid var(--border-soft);
    }
    .fleet.collapsed .rail {
      display: none;
    }
    .fleet.collapsed .full {
      display: flex;
    }
    /* The collapse rail is a desktop affordance — no dead control on mobile. */
    .collapse {
      display: none;
    }
    .stack {
      overflow-y: visible;
    }
  }
</style>
