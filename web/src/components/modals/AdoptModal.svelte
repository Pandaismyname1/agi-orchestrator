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
    if (s.drivable === false) {
      ui.toast("OpenCode sessions are shown for reference and feed learning, but can't be driven in the cockpit");
      return;
    }
    if (s.resumable === false) {
      ui.toast("this session's transcript is gone (archived) — can't resume it");
      return;
    }
    ui.openModal({ kind: "adopt-form", cwd: s.cwd, resumeId: s.sessionId });
  }
</script>

<Modal title="Adopt an existing session" width={600} onclose={() => ui.closeModal()}>
  <div class="hint">
    Coding-agent sessions found on this machine — Claude Code (CLI and the Claude Desktop app) plus
    OpenCode. Pick a Claude session to resume it in the cockpit. OpenCode sessions are shown for
    reference and feed the learning loop, but can't be driven here.
  </div>

  {#if sessions === null}
    <div class="empty">scanning…</div>
  {:else if sessions.length === 0}
    <div class="empty">no sessions found</div>
  {:else}
    <div class="list">
      {#each sessions as s (s.sessionId)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="row" class:gone={s.resumable === false || s.drivable === false} onclick={() => adopt(s)}>
          <span class="src {s.source ?? 'cli'}">{s.source ?? "cli"}</span>
          <div class="body">
            <div class="summary">{s.title || s.summary}</div>
            <div class="path">{s.projectCwd || s.cwd}</div>
          </div>
          <span class="meta">
            {#if s.resumable === false}archived{:else if s.drivable === false}reference{:else}{ago(s.lastActivity)}{/if}
          </span>
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
  .row.gone {
    opacity: 0.5;
  }
  .row.gone:hover {
    border-color: var(--border-soft);
    background: transparent;
  }
  .src {
    flex: none;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 6px;
    border: 1px solid var(--border-soft);
    color: var(--color-neutral-content);
  }
  .src.desktop {
    color: var(--color-secondary);
    border-color: rgba(96, 165, 250, 0.4);
    background: rgba(96, 165, 250, 0.08);
  }
  .src.opencode {
    color: var(--color-accent, #d97757);
    border-color: rgba(217, 119, 87, 0.4);
    background: rgba(217, 119, 87, 0.08);
  }
  .body {
    flex: 1;
    min-width: 0;
  }
  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path {
    font-size: 11px;
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    flex: none;
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
