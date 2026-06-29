<script lang="ts">
  import { ui } from "../lib/ui.svelte";
</script>

<div class="wrap">
  {#each ui.toasts as t (t.id)}
    <div class="toast-item">{t.message}</div>
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
    background: var(--color-base-200);
    border: 1px solid var(--color-error);
    color: var(--color-base-content);
    padding: 10px 15px;
    border-radius: 10px;
    font-size: 13px;
    max-width: 70vw;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  }
</style>
