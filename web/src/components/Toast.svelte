<script lang="ts">
  import { ui } from "../lib/ui.svelte";
</script>

<div class="wrap">
  {#each ui.toasts as t (t.id)}
    <div class="toast-item">
      <span class="msg">{t.message}</span>
      {#if t.action}
        <button
          class="act"
          onclick={() => {
            t.action?.run();
            ui.dismissToast(t.id);
          }}>{t.action.label}</button
        >
      {/if}
    </div>
  {/each}
</div>

<style>
  .wrap {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    z-index: 60;
    pointer-events: none;
  }
  .toast-item {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--color-base-200);
    border: 1px solid var(--color-error);
    color: var(--color-base-content);
    padding: 10px 15px;
    border-radius: 10px;
    font-size: 13px;
    max-width: 70vw;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
    pointer-events: auto;
  }
  .act {
    flex: none;
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    color: var(--color-primary);
    background: transparent;
    border: 1px solid var(--color-primary);
    border-radius: 7px;
    padding: 3px 10px;
    cursor: pointer;
    transition: background 0.12s;
  }
  .act:hover {
    background: rgba(34, 197, 94, 0.12);
  }
</style>
