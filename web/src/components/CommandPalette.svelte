<script lang="ts">
  /**
   * ⌘K / Ctrl-K command palette — the fast path to everything: open any modal,
   * start/stop the fleet, and jump to / drive any session by name. Pure frontend;
   * it dispatches the same WS messages and modal opens the buttons do.
   */
  import { tick } from "svelte";
  import type { SessionView } from "../lib/types";
  import type { IconName } from "./Icon.svelte";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import { pip } from "../lib/pip.svelte";
  import { alarm } from "../lib/alarm.svelte";
  import Icon from "./Icon.svelte";

  interface Command {
    id: string;
    label: string;
    group: string;
    icon?: IconName;
    hint?: string;
    keywords?: string;
    run: () => void;
  }

  let query = $state("");
  let selected = $state(0);
  let input = $state<HTMLInputElement | null>(null);

  let sessions = $derived(wsStore.snapshot?.sessions ?? []);

  // A session you can start (start() will launch / queue / block it).
  const STARTABLE = new Set(["idle", "stopped", "done", "error", "blocked"]);
  // A session start/stop handles as a real stop.
  const STOPPABLE = new Set(["running", "manual", "needs-input", "queued", "rate-limited"]);

  function focus(s: SessionView): void {
    ui.focusId = s.id;
    wsStore.send({ type: "focus", id: s.id });
  }
  function shortLabel(s: SessionView): string {
    const g = (s.goal ?? "").trim().replace(/\s+/g, " ");
    return g.length > 44 ? g.slice(0, 44) + "…" : g || s.id.slice(0, 8);
  }

  function stopAll(): void {
    if (confirm("Stop every session? This halts all running and queued agents.")) {
      wsStore.send({ type: "stopAll" });
    }
  }

  let commands = $derived.by<Command[]>(() => {
    const cmds: Command[] = [];

    // ---- Open ----
    cmds.push(
      { id: "new", label: "New session", group: "Open", icon: "plus", run: () => ui.openModal({ kind: "new" }) },
      { id: "adopt", label: "Adopt existing session", group: "Open", icon: "download", keywords: "resume import", run: () => ui.openModal({ kind: "adopt" }) },
      { id: "attach", label: "Attach a running session", group: "Open", icon: "plug", run: () => ui.openModal({ kind: "attach" }) },
      { id: "templates", label: "Templates", group: "Open", icon: "layers", keywords: "preset", run: () => ui.openModal({ kind: "templates" }) },
      { id: "workflow", label: "Workflow graph", group: "Open", icon: "graph", keywords: "dependencies dag depends chain", run: () => ui.openModal({ kind: "workflow" }) },
      { id: "webhooks", label: "Notifications & webhooks", group: "Open", icon: "bell", keywords: "slack discord notify", run: () => ui.openModal({ kind: "webhooks" }) },
      { id: "automations", label: "Automations", group: "Open", icon: "bolt", keywords: "rules triggers when then react start stop chain", run: () => ui.openModal({ kind: "automations" }) },
      { id: "analytics", label: "Analytics", group: "Open", icon: "graph", keywords: "metrics stats performance export csv report", run: () => ui.openModal({ kind: "analytics" }) },
      { id: "health", label: "System health", group: "Open", icon: "pulse", keywords: "health status diagnostics uptime version brain reachable db", run: () => ui.openModal({ kind: "health" }) },
      { id: "learn", label: "Learn — operator-prompt drafts", group: "Open", icon: "brain", run: () => ui.openModal({ kind: "learn" }) },
      { id: "settings", label: "Settings", group: "Open", icon: "settings", keywords: "provider budget concurrency", run: () => ui.openModal({ kind: "settings" }) },
    );

    // ---- Fleet ----
    cmds.push(
      { id: "startAll", label: "Start all sessions", group: "Fleet", icon: "play", run: () => { wsStore.send({ type: "startAll" }); ui.closePalette(); } },
      { id: "stopAll", label: "Stop all sessions", group: "Fleet", icon: "stop", keywords: "kill halt emergency", run: () => { stopAll(); ui.closePalette(); } },
      { id: "fleet", label: ui.fleetCollapsed ? "Expand fleet sidebar" : "Collapse fleet sidebar", group: "Fleet", icon: "layers", run: () => { ui.toggleFleet(); ui.closePalette(); } },
      { id: "sound", label: alarm.enabled ? "Mute sound alerts" : "Enable sound alerts", group: "Fleet", icon: "bell", run: () => { alarm.toggle(); ui.closePalette(); } },
    );
    if (pip.supported) {
      cmds.push({ id: "pip", label: "Toggle always-on-top status window", group: "Fleet", icon: "pip", keywords: "picture in picture", run: () => { void pip.toggle(); ui.closePalette(); } });
    }

    // ---- Sessions (dynamic) ----
    for (const s of sessions) {
      const label = shortLabel(s);
      const kw = `${s.cwd} ${s.status} ${s.id}`;
      cmds.push({
        id: `go:${s.id}`,
        label: `Go to: ${label}`,
        group: "Sessions",
        icon: "terminal",
        hint: s.status,
        keywords: kw,
        run: () => { focus(s); ui.closePalette(); },
      });
      if (STARTABLE.has(s.status)) {
        cmds.push({ id: `start:${s.id}`, label: `Start: ${label}`, group: "Sessions", icon: "play", hint: s.status, keywords: kw, run: () => { wsStore.send({ type: "start", id: s.id }); ui.closePalette(); } });
      }
      if (STOPPABLE.has(s.status)) {
        cmds.push({ id: `stop:${s.id}`, label: `Stop: ${label}`, group: "Sessions", icon: "stop", hint: s.status, keywords: kw, run: () => { wsStore.send({ type: "stop", id: s.id }); ui.closePalette(); } });
      }
      if (s.status === "running" || s.status === "manual") {
        const target = s.mode === "autopilot" ? "manual" : "autopilot";
        cmds.push({ id: `mode:${s.id}`, label: `Switch ${label} to ${target}`, group: "Sessions", icon: s.mode === "autopilot" ? "hand" : "bot", keywords: kw, run: () => { wsStore.send({ type: "setMode", id: s.id, mode: target }); ui.closePalette(); } });
      }
      cmds.push({ id: `hist:${s.id}`, label: `History: ${label}`, group: "Sessions", icon: "clock", keywords: kw, run: () => ui.openModal({ kind: "history", sessionId: s.id }) });
    }
    return cmds;
  });

  let filtered = $derived.by<Command[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const terms = q.split(/\s+/);
    return commands.filter((c) => {
      const hay = `${c.label} ${c.group} ${c.keywords ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  });

  // Group the filtered list for display, preserving first-seen group order.
  let groups = $derived.by<{ name: string; items: Command[] }[]>(() => {
    const order: string[] = [];
    const map = new Map<string, Command[]>();
    for (const c of filtered) {
      if (!map.has(c.group)) {
        map.set(c.group, []);
        order.push(c.group);
      }
      map.get(c.group)!.push(c);
    }
    return order.map((name) => ({ name, items: map.get(name)! }));
  });

  // Keep the selection in range whenever the filtered set changes.
  $effect(() => {
    if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
  });

  // Autofocus + reset when the palette opens.
  $effect(() => {
    if (ui.paletteOpen) {
      query = "";
      selected = 0;
      void tick().then(() => input?.focus());
    }
  });

  // The flat index of a command (for highlight + click).
  function indexOf(c: Command): number {
    return filtered.indexOf(c);
  }

  function onWindowKey(e: KeyboardEvent): void {
    // ⌘K / Ctrl-K toggles from anywhere.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      ui.togglePalette();
      return;
    }
    if (!ui.paletteOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      ui.closePalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) selected = (selected + 1) % filtered.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) selected = (selected - 1 + filtered.length) % filtered.length;
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[selected]?.run();
    }
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) ui.closePalette();
  }
</script>

<svelte:window onkeydown={onWindowKey} />

{#if ui.paletteOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="cp-back" onclick={onBackdrop}>
    <div class="cp" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="cp-search">
        <Icon name="spark" size={15} />
        <input
          bind:this={input}
          bind:value={query}
          placeholder="Type a command or search sessions…"
          spellcheck="false"
          autocomplete="off"
          aria-label="Command search"
        />
        <kbd>esc</kbd>
      </div>

      <div class="cp-list" role="listbox" tabindex="-1">
        {#if filtered.length === 0}
          <div class="cp-empty">No matching commands.</div>
        {:else}
          {#each groups as g (g.name)}
            <div class="cp-group">{g.name}</div>
            {#each g.items as c (c.id)}
              {@const i = indexOf(c)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div
                class="cp-item"
                class:on={i === selected}
                role="option"
                tabindex="-1"
                aria-selected={i === selected}
                onclick={() => c.run()}
                onmousemove={() => (selected = i)}
              >
                {#if c.icon}<span class="cp-ic"><Icon name={c.icon} size={14} /></span>{/if}
                <span class="cp-label">{c.label}</span>
                {#if c.hint}<span class="cp-hint">{c.hint}</span>{/if}
              </div>
            {/each}
          {/each}
        {/if}
      </div>

      <div class="cp-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> run</span>
        <span><kbd>⌘</kbd><kbd>K</kbd> toggle</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .cp-back {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 16, 0.55);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    z-index: 60;
  }
  .cp {
    width: 580px;
    max-width: calc(100vw - 32px);
    background: var(--color-base-100);
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
  }
  .cp-search {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 13px 15px;
    border-bottom: 1px solid var(--border-soft);
    color: var(--faint);
  }
  .cp-search input {
    flex: 1;
    border: none;
    background: transparent;
    font: inherit;
    font-size: 15px;
    color: var(--color-base-content);
    outline: none;
  }
  .cp-list {
    overflow-y: auto;
    padding: 6px;
  }
  .cp-group {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    color: var(--faint);
    padding: 10px 10px 4px;
  }
  .cp-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 9px;
    cursor: pointer;
    color: var(--color-base-content);
  }
  .cp-item.on {
    background: var(--color-primary);
    color: var(--color-primary-content);
  }
  .cp-ic {
    display: grid;
    place-items: center;
    width: 20px;
    flex: none;
    opacity: 0.85;
  }
  .cp-label {
    flex: 1;
    font-size: 13.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cp-hint {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
    opacity: 0.7;
    flex: none;
  }
  .cp-empty {
    padding: 22px;
    text-align: center;
    color: var(--faint);
    font-size: 13px;
  }
  .cp-foot {
    display: flex;
    gap: 16px;
    padding: 9px 14px;
    border-top: 1px solid var(--border-soft);
    font-size: 11px;
    color: var(--faint);
  }
  kbd {
    font: inherit;
    font-size: 10px;
    background: var(--color-base-300);
    border: 1px solid var(--border-strong);
    border-radius: 5px;
    padding: 1px 5px;
    margin: 0 1px;
  }
  @media (max-width: 560px) {
    .cp-back {
      padding-top: 6vh;
    }
  }
</style>
