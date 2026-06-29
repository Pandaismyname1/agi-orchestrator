<script lang="ts">
  import type { SessionView } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import { minutes } from "../lib/format";
  import Icon from "./Icon.svelte";
  import StatusBadge from "./StatusBadge.svelte";

  interface Props {
    session: SessionView;
    selected: boolean;
  }
  let { session: s, selected }: Props = $props();

  let isActive = $derived(["running", "manual", "needs-input"].includes(s.status));

  function focus() {
    ui.focusId = s.id;
    wsStore.send({ type: "focus", id: s.id });
  }
  function del(e: MouseEvent) {
    e.stopPropagation();
    if (confirm(`Delete session "${s.id}"? This removes it from config.json.`)) {
      wsStore.send({ type: "remove", id: s.id });
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="agent {s.status}" class:sel={selected} onclick={focus}>
  <div class="top">
    <span class="name">{s.id}</span>
    <span class="mode-chip {s.mode}">
      <Icon name={s.mode === "manual" ? "hand" : "bot"} size={12} />
      {s.mode}
    </span>
  </div>

  <p class="goal">{s.goal}</p>

  <div class="foot">
    <StatusBadge status={s.status} />
    <span class="metric tnum">turn {s.turns} · {minutes(s.elapsedMin)}</span>
  </div>

  {#if s.lastDecision}
    <div class="dec"><span class="k">brain</span> {s.lastDecision}</div>
  {/if}

  <div class="acts">
    {#if isActive}
      <button
        class="btn btn-xs"
        onclick={(e) => {
          e.stopPropagation();
          wsStore.send({ type: "stop", id: s.id });
        }}
      >
        <Icon name="stop" size={12} /> Stop
      </button>
    {:else}
      <button
        class="btn btn-xs"
        onclick={(e) => {
          e.stopPropagation();
          wsStore.send({ type: "start", id: s.id });
        }}
      >
        <Icon name="play" size={12} /> Start
      </button>
      <button
        class="btn btn-xs btn-square"
        title="Edit"
        onclick={(e) => {
          e.stopPropagation();
          ui.openModal({ kind: "edit", session: s });
        }}
      >
        <Icon name="edit" size={12} />
      </button>
      <button class="btn btn-xs btn-square del" title="Delete" onclick={del}>
        <Icon name="trash" size={12} />
      </button>
    {/if}
  </div>
</div>

<style>
  .agent {
    position: relative;
    padding: 13px 14px 12px;
    background: linear-gradient(180deg, var(--color-base-200), var(--color-base-100));
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-box);
    cursor: pointer;
    overflow: hidden;
    transition:
      border-color 0.15s,
      transform 0.1s,
      box-shadow 0.15s;
  }
  .agent::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--st-idle);
    opacity: 0.8;
  }
  .agent:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    border-color: var(--border-strong);
  }
  .agent.sel {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.35);
  }
  .agent.running::before {
    background: var(--st-running);
    box-shadow: 0 0 10px var(--st-running);
  }
  .agent.manual::before {
    background: var(--st-manual);
  }
  .agent.done::before {
    background: var(--st-done);
  }
  .agent.stopped::before,
  .agent.rate-limited::before {
    background: var(--st-stopped);
  }
  .agent.error::before {
    background: var(--st-error);
  }
  .agent.queued::before {
    background: var(--st-queued);
    opacity: 0.5;
  }
  .agent.needs-input::before {
    background: var(--st-needs-input);
  }
  .agent.needs-input {
    border-color: var(--st-needs-input);
    animation: cardpulse 1.4s ease-in-out infinite;
  }
  @keyframes cardpulse {
    0%,
    100% {
      box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.25);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(251, 191, 36, 0.6),
        0 0 18px rgba(251, 191, 36, 0.18);
    }
  }

  .top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    font-weight: 600;
    font-size: 13.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mode-chip {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--color-neutral-content);
    padding: 2px 7px;
    border: 1px solid var(--border-soft);
    border-radius: 20px;
  }
  .mode-chip.manual {
    color: var(--st-manual);
    border-color: rgba(96, 165, 250, 0.4);
  }
  .mode-chip.autopilot {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.4);
  }
  .goal {
    color: var(--color-neutral-content);
    font-size: 12px;
    margin: 9px 0 11px;
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 34px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .metric {
    margin-left: auto;
    font-size: 11px;
    color: var(--faint);
  }
  .dec {
    font-size: 11px;
    color: var(--faint);
    margin-top: 9px;
    padding-top: 9px;
    border-top: 1px dashed var(--border-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dec .k {
    color: var(--color-primary);
    font-weight: 600;
  }
  .acts {
    display: flex;
    gap: 6px;
    margin-top: 11px;
  }
  .del:hover {
    border-color: var(--color-error);
    color: var(--color-error);
  }
</style>
