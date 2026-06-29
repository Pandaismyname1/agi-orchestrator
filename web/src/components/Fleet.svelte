<script lang="ts">
  import type { SessionView } from "../lib/types";
  import { ui } from "../lib/ui.svelte";
  import Icon from "./Icon.svelte";
  import AgentCard from "./AgentCard.svelte";

  interface Props {
    sessions: SessionView[];
  }
  let { sessions }: Props = $props();
</script>

<section class="fleet">
  <div class="head">
    <span class="title">Fleet</span>
    <span class="count">{sessions.length}</span>
  </div>

  {#if sessions.length === 0}
    <div class="empty">
      <Icon name="bot" size={30} />
      <p>No sessions yet — create one or adopt an existing Claude session.</p>
    </div>
  {:else}
    <div class="grid">
      {#each sessions as s (s.id)}
        <AgentCard session={s} selected={s.id === ui.focusId} />
      {/each}
    </div>
  {/if}
</section>

<style>
  .fleet {
    border-bottom: 1px solid var(--border-soft);
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: 46vh;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px 8px;
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
  .grid {
    overflow-y: auto;
    padding: 4px 20px 16px;
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
    align-content: start;
  }
  .empty {
    color: var(--faint);
    padding: 40px;
    text-align: center;
  }
  .empty :global(svg) {
    margin: 0 auto 12px;
    opacity: 0.5;
  }
  @media (max-width: 720px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
