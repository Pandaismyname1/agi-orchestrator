<script lang="ts">
  import type { SessionView } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    session: SessionView;
    active: boolean;
  }
  let { session: s, active }: Props = $props();

  let manualPaused = $derived(s.mode === "manual" && active);

  // Only an actual brain CALL is ratable — match the three shapes the supervisor
  // emits for a decision ("→ …", "STOP — …", "NEEDS YOU — …"); status strings
  // like "blocked"/"queued"/"rolled back" are not decisions and show no thumbs.
  let ratable = $derived(!manualPaused && /^(→ |STOP — |NEEDS YOU — )/.test(s.lastDecision ?? ""));

  /** Toggle a thumb: clicking the active one clears it; otherwise set it. */
  function rate(thumb: "up" | "down") {
    const next = s.lastDecisionFeedback === thumb ? "clear" : thumb;
    wsStore.send({ type: "decisionFeedback", id: s.id, feedback: next });
  }
</script>

<div class="brain">
  <span class="lbl"><Icon name="bot" size={13} /> brain</span>
  <div class="bd">
    {#if manualPaused}
      <span class="manual">paused — you're driving (manual mode)</span>
    {:else if s.lastDecision}
      {s.lastDecision}
    {:else}
      <span class="muted">—</span>
    {/if}
    {#if s.error}
      <div class="err">{s.error}</div>
    {/if}
  </div>
  {#if ratable}
    <div class="rate" title="Rate this decision — feeds the learning loop">
      <button
        class="thumb up"
        class:on={s.lastDecisionFeedback === "up"}
        aria-pressed={s.lastDecisionFeedback === "up"}
        aria-label="Good decision"
        onclick={() => rate("up")}
      >
        <Icon name="thumbsUp" size={13} />
      </button>
      <button
        class="thumb down"
        class:on={s.lastDecisionFeedback === "down"}
        aria-pressed={s.lastDecisionFeedback === "down"}
        aria-label="Bad decision"
        onclick={() => rate("down")}
      >
        <Icon name="thumbsDown" size={13} />
      </button>
    </div>
  {/if}
</div>

<style>
  .brain {
    padding: 10px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--color-base-200);
    font-size: 12.5px;
    line-height: 1.5;
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  @media (max-width: 640px) {
    .brain {
      padding: 10px 14px;
    }
  }
  .lbl {
    color: var(--color-primary);
    font-weight: 700;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 1px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding-top: 1px;
    flex: none;
  }
  .bd {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .rate {
    flex: none;
    display: flex;
    gap: 4px;
    align-self: flex-start;
    padding-top: 1px;
  }
  .thumb {
    display: inline-grid;
    place-items: center;
    width: 26px;
    height: 24px;
    border-radius: 7px;
    border: 1px solid var(--border-soft);
    background: var(--color-base-100);
    color: var(--faint);
    cursor: pointer;
    transition: color 0.13s, border-color 0.13s, background 0.13s;
  }
  .thumb:hover {
    color: var(--color-base-content);
    border-color: var(--border-strong);
  }
  .thumb.up.on {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.55);
    background: rgba(34, 197, 94, 0.1);
  }
  .thumb.down.on {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.55);
    background: rgba(248, 113, 113, 0.1);
  }
  .manual {
    color: var(--color-secondary);
  }
  .muted {
    color: var(--faint);
  }
  .err {
    color: var(--color-error);
    margin-top: 6px;
  }
</style>
