<script lang="ts">
  import Icon from "./Icon.svelte";

  interface Props {
    screen: string;
    active: boolean;
  }
  let { screen, active }: Props = $props();
</script>

<div class="screen-wrap">
  {#if screen}
    <div class="term"><pre class="font-mono-term">{screen}</pre></div>
  {:else}
    <div class="empty">
      <Icon name="terminal" size={30} />
      <p>{active ? "waiting for screen…" : "session not running"}</p>
    </div>
  {/if}
</div>

<style>
  .screen-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px;
  }
  .term {
    background: var(--term-bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-box);
    padding: 14px 16px;
    min-height: 100%;
  }
  pre {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.4;
    color: #cbd5e1;
    white-space: pre;
    tab-size: 2;
  }
  .empty {
    color: var(--faint);
    padding: 48px;
    text-align: center;
  }
  .empty :global(svg) {
    margin: 0 auto 12px;
    opacity: 0.5;
  }
</style>
