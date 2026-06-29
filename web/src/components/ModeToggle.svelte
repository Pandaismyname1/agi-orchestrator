<script lang="ts">
  import type { SessionView } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    session: SessionView;
  }
  let { session: s }: Props = $props();

  function set(mode: "manual" | "autopilot") {
    if (s.mode !== mode) wsStore.send({ type: "setMode", id: s.id, mode });
  }
</script>

<div class="mtoggle" role="group" aria-label="Session mode">
  <button class="seg" class:on={s.mode === "manual"} class:manual={true} onclick={() => set("manual")}>
    <Icon name="hand" size={13} /> Manual
  </button>
  <button class="seg" class:on={s.mode === "autopilot"} onclick={() => set("autopilot")}>
    <Icon name="bot" size={13} /> Autopilot
  </button>
</div>

<style>
  .mtoggle {
    display: inline-flex;
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    overflow: hidden;
  }
  .seg {
    font-size: 12px;
    padding: 5px 12px;
    cursor: pointer;
    color: var(--color-neutral-content);
    background: transparent;
    border: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition:
      background 0.15s,
      color 0.15s;
  }
  .seg + .seg {
    border-left: 1px solid var(--border-strong);
  }
  .seg:hover {
    color: var(--color-base-content);
  }
  .seg.on {
    background: var(--color-primary);
    color: var(--color-primary-content);
    font-weight: 600;
  }
  .seg.on.manual {
    background: var(--color-secondary);
    color: var(--color-secondary-content);
  }
</style>
