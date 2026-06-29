<script lang="ts">
  import type { SessionView } from "../lib/types";
  import { ui } from "../lib/ui.svelte";
  import Icon from "./Icon.svelte";
  import AgentCard from "./AgentCard.svelte";

  interface Props {
    sessions: SessionView[];
  }
  let { sessions }: Props = $props();

  // Compact status breakdown shown beside the section title.
  const BREAKDOWN: { key: string; label: string; match: (s: SessionView) => boolean }[] = [
    { key: "running", label: "running", match: (s) => s.status === "running" || s.status === "manual" },
    { key: "error", label: "error", match: (s) => s.status === "error" },
    { key: "needs-input", label: "needs you", match: (s) => s.status === "needs-input" },
    { key: "queued", label: "queued", match: (s) => s.status === "queued" },
    { key: "done", label: "done", match: (s) => s.status === "done" },
  ];
  let counts = $derived(
    BREAKDOWN.map((b) => ({ ...b, n: sessions.filter(b.match).length })).filter((b) => b.n > 0),
  );
</script>

<section class="fleet">
  <div class="head">
    <span class="title">Fleet</span>
    <span class="count">{sessions.length}</span>
    <div class="breakdown">
      {#each counts as c (c.key)}
        <span class="chip {c.key}"><b class="tnum">{c.n}</b> {c.label}</span>
      {/each}
    </div>
  </div>

  {#if sessions.length === 0}
    <div class="onboard">
      <span class="ob-mark"><Icon name="bot" size={26} /></span>
      <h3>Mission control is empty</h3>
      <p>Create a session to put an agent to work, or adopt one you already started in Claude Code.</p>
      <div class="ob-acts">
        <button class="btn btn-primary btn-sm" onclick={() => ui.openModal({ kind: "new" })}>
          <Icon name="plus" size={13} /> New session
        </button>
        <button class="btn btn-sm" onclick={() => ui.openModal({ kind: "adopt" })}>
          <Icon name="download" size={13} /> Adopt existing
        </button>
      </div>
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
  .breakdown {
    display: flex;
    gap: 6px;
    margin-left: 4px;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 11px;
    color: var(--color-neutral-content);
    padding: 1px 8px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
  }
  .chip b {
    font-weight: 700;
    color: var(--color-base-content);
  }
  .chip.running {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.35);
  }
  .chip.running b {
    color: var(--st-running);
  }
  .chip.needs-input {
    color: var(--st-needs-input);
    border-color: rgba(251, 191, 36, 0.45);
    background: rgba(251, 191, 36, 0.07);
  }
  .chip.needs-input b {
    color: var(--st-needs-input);
  }
  .chip.queued {
    color: var(--st-queued);
    border-color: rgba(96, 165, 250, 0.35);
  }
  .chip.error {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.5);
    background: rgba(248, 113, 113, 0.08);
  }
  .chip.error b {
    color: var(--st-error);
  }
  .grid {
    overflow-y: auto;
    padding: 4px 20px 16px;
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
    align-content: start;
  }
  .onboard {
    text-align: center;
    padding: 36px 20px 28px;
    max-width: 440px;
    margin: 0 auto;
  }
  .ob-mark {
    width: 52px;
    height: 52px;
    border-radius: 14px;
    display: inline-grid;
    place-items: center;
    color: var(--color-primary);
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid rgba(34, 197, 94, 0.3);
    margin-bottom: 14px;
  }
  .onboard h3 {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 700;
    color: var(--color-base-content);
  }
  .onboard p {
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--color-neutral-content);
    line-height: 1.5;
  }
  .ob-acts {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
  @media (max-width: 720px) {
    .grid {
      grid-template-columns: 1fr;
      /* On phones, let the page scroll as one column instead of a cramped
         inner scroll region (which otherwise compresses the card rows). */
      overflow-y: visible;
    }
    .fleet {
      max-height: none;
    }
  }
</style>
