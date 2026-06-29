<script lang="ts">
  import type { SessionView, FocusView } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import { minutes } from "../lib/format";
  import Icon from "./Icon.svelte";
  import StatusBadge from "./StatusBadge.svelte";
  import ModeToggle from "./ModeToggle.svelte";
  import MessageBar from "./MessageBar.svelte";
  import AttentionPanel from "./AttentionPanel.svelte";
  import BrainLine from "./BrainLine.svelte";
  import TerminalScreen from "./TerminalScreen.svelte";

  interface Props {
    session: SessionView | undefined;
    focus: FocusView | undefined;
  }
  let { session: s, focus }: Props = $props();

  let active = $derived(!!s && ["running", "manual", "needs-input"].includes(s.status));
  let screen = $derived(s && focus && focus.id === s.id ? focus.screen : "");
  let attention = $derived(s && s.status === "needs-input" ? s.attention : null);
</script>

<section class="detail">
  {#if !s}
    <div class="empty">
      <Icon name="terminal" size={30} />
      <p>No session selected.</p>
    </div>
  {:else}
    <div class="dhead">
      <div class="row1">
        <span class="name">{s.id}</span>
        <StatusBadge status={s.status} />
        {#if active}
          <div class="grow"><ModeToggle session={s} /></div>
        {/if}
        <button
          class="btn btn-sm"
          class:grow={!active}
          onclick={() => ui.openModal({ kind: "history", sessionId: s.id })}
        >
          <Icon name="clock" size={13} /> History
        </button>
      </div>
      <div class="goal">{s.goal}</div>
      <div class="statrow">
        <span class="dstat">turns <b class="tnum">{s.turns}</b></span>
        <span class="dstat">elapsed <b class="tnum">{minutes(s.elapsedMin)}</b></span>
        <span class="dstat">cwd <b>{s.cwd}</b></span>
      </div>
    </div>

    {#if attention}
      <AttentionPanel sessionId={s.id} {attention} />
    {/if}

    {#if active && s.mode === "manual"}
      <MessageBar sessionId={s.id} />
    {/if}

    <BrainLine session={s} {active} />
    <TerminalScreen {screen} {active} />
  {/if}
</section>

<style>
  .detail {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .dhead {
    padding: 14px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--color-base-100);
  }
  .row1 {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .name {
    font-weight: 700;
    font-size: 15px;
  }
  .grow {
    margin-left: auto;
  }
  .goal {
    color: var(--color-neutral-content);
    font-size: 12.5px;
    margin-top: 6px;
    max-width: 80ch;
  }
  .statrow {
    margin-top: 10px;
  }
  .dstat {
    display: inline-flex;
    gap: 6px;
    margin-right: 18px;
    font-size: 12px;
    color: var(--faint);
  }
  .dstat b {
    color: var(--color-base-content);
    font-weight: 600;
  }
  .empty {
    color: var(--faint);
    padding: 48px;
    text-align: center;
    margin: auto;
  }
  .empty :global(svg) {
    margin: 0 auto 12px;
    opacity: 0.5;
  }
</style>
