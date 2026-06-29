<script lang="ts">
  import type { SessionView } from "../lib/types";
  import Icon from "./Icon.svelte";

  interface Props {
    session: SessionView;
    active: boolean;
  }
  let { session: s, active }: Props = $props();

  let manualPaused = $derived(s.mode === "manual" && active);
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
</div>

<style>
  .brain {
    padding: 10px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--color-base-200);
    font-size: 12.5px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
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
