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
  import Transcript from "./Transcript.svelte";

  interface Props {
    session: SessionView | undefined;
    focus: FocusView | undefined;
  }
  let { session: s, focus }: Props = $props();

  let active = $derived(!!s && ["running", "manual", "needs-input"].includes(s.status));
  let screen = $derived(s && focus && focus.id === s.id ? focus.screen : "");
  let attention = $derived(s && s.status === "needs-input" ? s.attention : null);

  // Output view: live PTY screen vs the persistent transcript. Defaults to live
  // while running and flips to the transcript once a session isn't live — reset
  // per session, but the user can override with the tabs.
  let view = $state<"live" | "transcript">("live");
  let userPicked = $state(false);
  let lastSid = "";
  $effect(() => {
    if (s && s.id !== lastSid) {
      lastSid = s.id;
      userPicked = false;
      view = active ? "live" : "transcript";
    } else if (!userPicked) {
      view = active ? "live" : "transcript";
    }
  });
  function pickView(v: "live" | "transcript") {
    userPicked = true;
    view = v;
  }
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
        <div class="idgroup">
          <span class="name">{s.id}</span>
          <StatusBadge status={s.status} />
        </div>
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

    <div class="otabs">
      <button class="otab" class:on={view === "live"} onclick={() => pickView("live")}>
        <span class="odot" class:livedot={active}></span> Live
      </button>
      <button class="otab" class:on={view === "transcript"} onclick={() => pickView("transcript")}>
        <Icon name="clock" size={12} /> Transcript
      </button>
    </div>

    {#if view === "live"}
      <TerminalScreen {screen} {active} />
    {:else}
      <Transcript sessionId={s.id} reloadKey={`${s.status}:${s.turns}`} />
    {/if}
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
    flex-wrap: wrap;
    gap: 10px;
  }
  .idgroup {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .name {
    font-weight: 700;
    font-size: 15px;
    overflow-wrap: anywhere;
  }
  .grow {
    margin-left: auto;
  }
  .row1 :global(.btn) {
    flex: none;
  }
  .goal {
    color: var(--color-neutral-content);
    font-size: 12.5px;
    line-height: 1.5;
    margin-top: 8px;
    max-width: 80ch;
    overflow-wrap: anywhere;
  }
  .statrow {
    margin-top: 11px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
  }
  .dstat {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    font-size: 12px;
    color: var(--faint);
    min-width: 0;
  }
  .dstat b {
    color: var(--color-base-content);
    font-weight: 600;
    overflow-wrap: anywhere;
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
  .otabs {
    flex: none;
    display: flex;
    gap: 4px;
    padding: 8px 20px 0;
    background: var(--color-base-100);
  }
  .otab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-neutral-content);
    background: transparent;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 8px 8px 0 0;
    padding: 6px 12px;
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s;
  }
  .otab:hover {
    color: var(--color-base-content);
    background: var(--color-base-200);
  }
  .otab.on {
    color: var(--color-base-content);
    background: var(--color-base-200);
    border-color: var(--border-soft);
  }
  .odot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--st-idle);
  }
  .odot.livedot {
    background: var(--color-primary);
    box-shadow: 0 0 6px var(--color-primary);
  }
  @media (max-width: 640px) {
    .otabs {
      padding: 8px 14px 0;
    }
    /* page scrolls as one column on mobile — let the detail flow, not clip */
    .detail {
      overflow: visible;
    }
    .dhead {
      padding: 14px;
    }
    .row1 {
      align-items: stretch;
      flex-direction: column;
    }
    .grow {
      margin-left: 0;
    }
    .row1 :global(.mtoggle) {
      align-self: flex-start;
    }
    .row1 :global(.btn) {
      align-self: flex-start;
    }
  }
</style>
