<script lang="ts">
  import type { Snippet } from "svelte";
  import { fade, scale } from "svelte/transition";
  import Icon from "./Icon.svelte";

  interface Props {
    title: string;
    width?: number;
    onclose: () => void;
    children: Snippet;
  }
  let { title, width = 480, onclose, children }: Props = $props();

  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onclose();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="back" onclick={onBackdrop} transition:fade={{ duration: 120 }}>
  <div
    class="dialog"
    style="width:{width}px"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    in:scale={{ start: 0.97, duration: 160 }}
  >
    <div class="head">
      <h2>{title}</h2>
      <button class="btn btn-ghost btn-xs btn-square" onclick={onclose} aria-label="Close">
        <Icon name="x" size={16} />
      </button>
    </div>
    {@render children()}
  </div>
</div>

<style>
  .back {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 16, 0.6);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .dialog {
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    background: var(--color-base-100);
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    padding: 20px 22px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
  }
  .head h2 {
    flex: 1;
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }
</style>
