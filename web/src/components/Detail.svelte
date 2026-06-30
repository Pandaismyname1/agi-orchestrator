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

  function saveAsTemplate(sess: SessionView) {
    const name = prompt("Save this session's settings as a template named:", sess.id);
    if (name === null) return;
    const n = name.trim();
    if (!n) return;
    wsStore.send({ type: "saveAsTemplate", id: sess.id, name: n });
    ui.toast(`saved template “${n}”`);
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
        {:else if s.canContinue}
          <button
            class="btn btn-primary btn-sm grow"
            title="Resume this conversation with a new instruction"
            onclick={() => ui.openModal({ kind: "continue", session: s })}
          >
            <Icon name="play" size={13} /> Continue
          </button>
        {/if}
        <button
          class="btn btn-sm"
          class:grow={!active && !s.canContinue}
          onclick={() => ui.openModal({ kind: "history", sessionId: s.id })}
        >
          <Icon name="clock" size={13} /> History
        </button>
        <button
          class="btn btn-sm"
          title={active ? "Edit goal / instructions live (applies next turn)" : "Edit this session"}
          onclick={() => ui.openModal({ kind: "edit", session: s })}
        >
          <Icon name="edit" size={13} /> Edit
        </button>
        <button
          class="btn btn-sm btn-square"
          aria-label="Save this session's settings as a template"
          title="Save as template"
          onclick={() => saveAsTemplate(s)}
        >
          <Icon name="layers" size={13} />
        </button>
      </div>
      <div class="goal">{s.goal}</div>
      <div class="statrow">
        <span class="dstat">turns <b class="tnum">{s.turns}</b></span>
        <span class="dstat">elapsed <b class="tnum">{minutes(s.elapsedMin)}</b></span>
        <span class="dstat">cwd <b>{s.cwd}</b></span>
        {#if s.feedback && (s.feedback.up || s.feedback.down)}
          <span
            class="dstat fb"
            title="Your thumbs on this agent's brain decisions — {Math.round(
              (s.feedback.up / (s.feedback.up + s.feedback.down)) * 100,
            )}% approved"
          >
            <Icon name="thumbsUp" size={12} /> <b class="tnum">{s.feedback.up}</b>
            <Icon name="thumbsDown" size={12} /> <b class="tnum">{s.feedback.down}</b>
          </span>
        {/if}
        {#if s.prState === "open" && s.prUrl}
          <a class="prchip open" href={s.prUrl} target="_blank" rel="noopener noreferrer" title="Open the pull request on GitHub">
            <Icon name="graph" size={12} /> View PR ↗
          </a>
        {:else if s.prState === "opening"}
          <span class="prchip opening" title="Opening a pull request…">opening PR…</span>
        {:else if s.prState === "failed"}
          <span class="prchip failed" title={s.lastDecision}>PR failed</span>
        {:else if s.prState === "skipped"}
          <span class="prchip skipped" title={s.lastDecision}>PR skipped</span>
        {/if}
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
  .dstat.fb {
    gap: 4px;
    align-items: center;
  }
  .dstat.fb :global(svg) {
    opacity: 0.75;
  }
  .prchip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    padding: 2px 9px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
    color: var(--faint);
    text-decoration: none;
    white-space: nowrap;
  }
  .prchip.open {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.5);
    background: rgba(34, 197, 94, 0.08);
  }
  .prchip.open:hover {
    border-color: var(--st-running);
  }
  .prchip.opening {
    color: var(--st-manual);
    border-color: rgba(96, 165, 250, 0.5);
  }
  .prchip.failed {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.5);
  }
  .prchip.skipped {
    color: var(--faint);
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
