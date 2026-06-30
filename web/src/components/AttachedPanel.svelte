<script lang="ts">
  import type { AttachedView } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import { ago } from "../lib/format";
  import Icon from "./Icon.svelte";

  interface Props {
    attached: AttachedView[];
  }
  let { attached }: Props = $props();

  /** Short id for display — a uuid is long, the first segment is enough to recognize. */
  function shortId(id: string): string {
    return id.length > 13 ? id.slice(0, 8) + "…" : id;
  }

  function detach(a: AttachedView) {
    if (confirm(`Detach "${shortId(a.sessionId)}"? The daemon stops driving it; your claude keeps running unmanaged.`)) {
      wsStore.send({ type: "detach", id: a.sessionId });
    }
  }
</script>

<section class="attached">
  <div class="head">
    <Icon name="plug" size={13} />
    <span class="title">Attached</span>
    <span class="count tnum">{attached.length}</span>
    <button
      class="add"
      title="Attach a hand-started session"
      aria-label="Attach a hand-started session"
      onclick={() => ui.openModal({ kind: "attach" })}
    >
      <Icon name="plus" size={14} />
    </button>
  </div>

  <p class="sub">Hand-started <span class="mono">claude</span> sessions the daemon drives via the Stop hook.</p>

  <div class="stack">
    {#each attached as a (a.sessionId)}
      <div class="acard" class:needs={a.needsInput}>
        <div class="acard-top">
          <span class="aid mono" title={a.sessionId}>{shortId(a.sessionId)}</span>
          {#if a.needsInput}
            <span class="needsbadge" title="The brain wanted a human decision — check this session in its terminal">needs you</span>
          {/if}
          <span class="aturns tnum" title="Turns driven so far">turn {a.turns}</span>
          <button
            class="detach"
            title="Detach (stop driving this session)"
            aria-label="Detach {shortId(a.sessionId)}"
            onclick={() => detach(a)}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
        <p class="agoal">{a.goal}</p>
        <div class="ameta">
          {#if a.lastActivity}
            <span class:stop={a.lastAction === "stop"} class:cont={a.lastAction === "continue"}>
              {a.lastAction === "stop" ? "stopped" : "driving"} · {ago(a.lastActivity)}
            </span>
          {:else}
            <span class="idle">waiting for first turn</span>
          {/if}
        </div>
        {#if a.lastReason}
          <div class="areason" title={a.lastReason}>{a.lastReason}</div>
        {/if}
      </div>
    {/each}
  </div>
</section>

<style>
  .attached {
    border-top: 1px solid var(--border-soft);
    padding: 11px 16px 14px;
    flex: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--color-neutral-content);
  }
  .title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.4px;
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
  .add {
    margin-left: auto;
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    border: 1px solid var(--border-soft);
    background: var(--color-base-200);
    color: var(--color-neutral-content);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .add:hover {
    color: var(--color-base-content);
    border-color: var(--border-strong);
  }
  .sub {
    margin: 6px 0 10px;
    font-size: 11px;
    line-height: 1.45;
    color: var(--faint);
  }
  .mono,
  .aid {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .acard {
    padding: 9px 11px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-box);
  }
  .acard.needs {
    border-color: var(--st-needs-input);
    background: rgba(251, 191, 36, 0.06);
  }
  .needsbadge {
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 700;
    color: var(--color-accent-content, #1a1a1a);
    background: var(--st-needs-input);
    border-radius: 20px;
    padding: 1px 7px;
  }
  .acard-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .aid {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-base-content);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .aturns {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--faint);
  }
  .detach {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    border: 1px solid var(--border-soft);
    background: transparent;
    color: var(--faint);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .detach:hover {
    color: var(--color-error);
    border-color: var(--color-error);
  }
  .agoal {
    margin: 7px 0 6px;
    font-size: 11.5px;
    line-height: 1.4;
    color: var(--color-neutral-content);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .ameta {
    font-size: 10.5px;
    color: var(--faint);
  }
  .ameta .cont {
    color: var(--st-running);
  }
  .ameta .stop {
    color: var(--st-stopped);
  }
  .ameta .idle {
    color: var(--faint);
    font-style: italic;
  }
  .areason {
    margin-top: 4px;
    font-size: 10.5px;
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
