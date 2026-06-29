<script lang="ts">
  import type { DiscoveredSession } from "../../lib/types";
  import { api } from "../../lib/api";
  import { ui } from "../../lib/ui.svelte";
  import { ago } from "../../lib/format";
  import Modal from "../Modal.svelte";

  let sessions = $state<DiscoveredSession[] | null>(null);

  // kick off the scan once
  api
    .discover()
    .then((s) => (sessions = s))
    .catch(() => (sessions = []));

  function adopt(s: DiscoveredSession) {
    ui.openModal({ kind: "adopt-form", cwd: s.cwd, resumeId: s.sessionId });
  }
</script>

<Modal title="Adopt an existing session" width={580} onclose={() => ui.closeModal()}>
  <div class="hint">
    Claude Code sessions found on this machine. Pick one to resume it in the cockpit.
  </div>

  {#if sessions === null}
    <div class="empty">scanning…</div>
  {:else if sessions.length === 0}
    <div class="empty">no sessions found</div>
  {:else}
    <div class="list">
      {#each sessions as s (s.sessionId)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="row" onclick={() => adopt(s)}>
          <span class="rid">{s.sessionId.slice(0, 8)}</span>
          <span class="summary">{s.summary}</span>
          <span class="meta">{s.turns}t · {ago(s.lastActivity)}</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="facts">
    <button class="btn btn-sm" onclick={() => ui.closeModal()}>Close</button>
  </div>
</Modal>

<style>
  .hint {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin-bottom: 10px;
  }
  .list {
    max-height: 50vh;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 11px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    margin-bottom: 7px;
    cursor: pointer;
    transition:
      border-color 0.15s,
      background 0.15s;
  }
  .row:hover {
    border-color: var(--color-primary);
    background: var(--color-base-200);
  }
  .rid {
    color: var(--color-neutral-content);
    font-size: 12px;
  }
  .summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    color: var(--color-neutral-content);
    font-size: 12px;
  }
  .empty {
    color: var(--faint);
    padding: 24px;
    text-align: center;
  }
  .facts {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 14px;
  }
</style>
