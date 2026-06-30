<script lang="ts">
  import type { Provider, Budget, SessionView } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import { pip } from "../lib/pip.svelte";
  import { alarm } from "../lib/alarm.svelte";
  import Icon from "./Icon.svelte";
  import BudgetMeter from "./BudgetMeter.svelte";
  import UsageMeter from "./UsageMeter.svelte";

  let usage = $derived(wsStore.snapshot?.usage);

  interface Props {
    provider: Provider | undefined;
    budget: Budget | null | undefined;
    sessions: SessionView[];
  }
  let { provider, budget, sessions }: Props = $props();

  let needsYou = $derived(sessions.filter((s) => s.status === "needs-input"));
  let errored = $derived(sessions.filter((s) => s.status === "error"));
  let running = $derived(sessions.filter((s) => s.status === "running" || s.status === "manual").length);

  let learning = $derived(wsStore.snapshot?.learning);
  let learnDraft = $derived(
    !!learning && (learning.global.hasDraft || learning.projects.some((p) => p.hasDraft)),
  );

  function jumpTo(list: SessionView[]) {
    const target = list[0];
    if (!target) return;
    ui.focusId = target.id;
    wsStore.send({ type: "focus", id: target.id });
  }

  function stopAll() {
    if (confirm("Stop every session? This halts all running and queued agents.")) {
      wsStore.send({ type: "stopAll" });
    }
  }

  let soundTitle = $derived(
    alarm.enabled
      ? alarm.active
        ? "Alarm sounding — click to mute"
        : "Sound alerts on — click to mute"
      : "Sound alerts off — click to enable an audible alarm for errors / needs-you",
  );
</script>

<header>
  <div class="brand">
    <span class="mark"><Icon name="spark" size={17} /></span>
    <div>
      <h1>AGI</h1>
      <div class="sub">autopilot orchestrator</div>
    </div>
  </div>

  {#if running > 0}
    <div class="live" title="Sessions actively running">
      <span class="pulse-dot"></span>{running} live
    </div>
  {/if}

  <div class="spacer"></div>

  {#if errored.length > 0}
    <button class="alert-pill errored" onclick={() => jumpTo(errored)} title="A session errored — work has stopped">
      <Icon name="alert" size={14} />
      {errored.length} {errored.length === 1 ? "error" : "errors"}
    </button>
  {/if}
  {#if needsYou.length > 0}
    <button class="alert-pill needsyou" onclick={() => jumpTo(needsYou)}>
      <Icon name="alert" size={14} />
      {needsYou.length} {needsYou.length === 1 ? "needs" : "need"} you
    </button>
  {/if}
  <button
    class="btn btn-sm btn-square sound"
    class:on={alarm.enabled}
    class:ringing={alarm.active}
    title={soundTitle}
    aria-pressed={alarm.enabled}
    onclick={() => alarm.toggle()}
  >
    <Icon name={alarm.enabled ? "bell" : "bellOff"} size={15} />
  </button>

  <button class="btn btn-primary btn-sm" onclick={() => wsStore.send({ type: "startAll" })}>
    <Icon name="play" size={13} /> Start all
  </button>
  <button
    class="btn btn-sm stop-all"
    aria-label="Stop all sessions"
    title="Stop every running and queued session"
    onclick={stopAll}
  >
    <Icon name="stop" size={13} /> Stop all
  </button>
  <button class="btn btn-sm" onclick={() => ui.openModal({ kind: "adopt" })}>
    <Icon name="download" size={13} /> Adopt
  </button>
  <button
    class="btn btn-sm hide-sm"
    title="Drive a claude you started by hand (Stop-hook attach)"
    onclick={() => ui.openModal({ kind: "attach" })}
  >
    <Icon name="plug" size={13} /> Attach
  </button>
  <button class="btn btn-sm" onclick={() => ui.openModal({ kind: "new" })}>
    <Icon name="plus" size={13} /> New
  </button>
  <button
    class="btn btn-sm btn-square hide-sm"
    title={pip.supported ? "Always-on-top status window" : "Needs Chrome/Edge (Document PiP)"}
    disabled={!pip.supported}
    onclick={() => pip.toggle()}
  >
    <Icon name="pip" size={15} />
  </button>
  <button
    class="btn btn-sm hide-sm"
    title="Templates — reusable session presets"
    onclick={() => ui.openModal({ kind: "templates" })}
  >
    <Icon name="layers" size={14} /> Templates
  </button>
  <button
    class="btn btn-sm learn-btn"
    title="Learn — review & approve operator-prompt drafts"
    onclick={() => ui.openModal({ kind: "learn" })}
  >
    <Icon name="brain" size={14} /> Learn
    {#if learnDraft}
      <span class="draft-dot" title="A draft is waiting for review"></span>
    {/if}
  </button>
  <button
    class="btn btn-sm btn-square"
    title="Settings — provider, budget, concurrency, defaults"
    onclick={() => ui.openModal({ kind: "settings" })}
  >
    <Icon name="settings" size={15} />
  </button>

  {#if usage}
    <div class="ml hide-sm"><UsageMeter {usage} /></div>
  {:else if budget}
    <div class="ml hide-sm"><BudgetMeter {budget} /></div>
  {/if}

  <div class="provider" title="Local brain model (Ollama / LM Studio)">
    <span class="dot" class:ok={provider?.ok} class:bad={provider && !provider.ok}></span>
    <span>{provider?.model ?? "connecting…"}</span>
  </div>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: rgba(15, 23, 42, 0.85);
    backdrop-filter: blur(8px);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .mark {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: linear-gradient(135deg, var(--color-primary), #16a34a);
    display: grid;
    place-items: center;
    color: var(--color-primary-content);
    box-shadow:
      0 0 0 1px rgba(34, 197, 94, 0.4),
      0 2px 10px rgba(34, 197, 94, 0.25);
  }
  h1 {
    font-size: 15px;
    margin: 0;
    font-weight: 700;
    letter-spacing: 0.3px;
  }
  .sub {
    font-size: 11px;
    color: var(--faint);
    letter-spacing: 0.4px;
  }
  .live {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-primary);
    padding: 3px 9px;
    border: 1px solid rgba(34, 197, 94, 0.35);
    border-radius: 20px;
    background: rgba(34, 197, 94, 0.06);
  }
  .pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-primary);
    box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.6);
    animation: ping 1.6s ease-out infinite;
  }
  @keyframes ping {
    0% {
      box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
    }
    70%,
    100% {
      box-shadow: 0 0 0 6px rgba(34, 197, 94, 0);
    }
  }
  .spacer {
    flex: 1;
  }
  .alert-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 700;
    border-radius: 9px;
    padding: 6px 12px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .alert-pill:hover {
    filter: brightness(1.05);
  }
  .alert-pill.needsyou {
    color: var(--color-accent-content);
    background: var(--color-warning);
    border-color: var(--color-warning);
    animation: nag-amber 1.1s ease-in-out infinite;
  }
  .alert-pill.errored {
    color: #2a0808;
    background: var(--color-error);
    border-color: var(--color-error);
    animation: nag-red 1s ease-in-out infinite;
  }
  @keyframes nag-amber {
    0%,
    100% {
      box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.5);
    }
    50% {
      box-shadow: 0 0 0 5px rgba(251, 191, 36, 0);
    }
  }
  @keyframes nag-red {
    0%,
    100% {
      box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.6);
    }
    50% {
      box-shadow: 0 0 0 6px rgba(248, 113, 113, 0);
    }
  }
  .stop-all {
    color: var(--color-error);
    border-color: rgba(248, 113, 113, 0.5);
  }
  .stop-all:hover {
    background: rgba(248, 113, 113, 0.1);
    border-color: var(--color-error);
  }
  .sound.on {
    color: var(--color-primary);
    border-color: rgba(34, 197, 94, 0.4);
  }
  .sound.ringing {
    color: var(--color-error);
    border-color: var(--color-error);
    animation: nag-red 1s ease-in-out infinite;
  }
  .learn-btn {
    position: relative;
  }
  .draft-dot {
    position: absolute;
    top: -3px;
    right: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-warning);
    box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.6);
    animation: nag-amber 1.3s ease-in-out infinite;
  }
  .ml {
    margin-left: 8px;
  }
  .provider {
    color: var(--color-neutral-content);
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 7px;
    margin-left: 6px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--st-idle);
  }
  .dot.ok {
    background: var(--color-primary);
    box-shadow: 0 0 8px rgba(34, 197, 94, 0.6);
  }
  .dot.bad {
    background: var(--color-error);
  }

  @media (max-width: 640px) {
    header {
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 14px;
    }
    /* force the action cluster onto its own row below the brand */
    .spacer {
      flex-basis: 100%;
      height: 0;
      margin: 0;
    }
    .sub {
      display: none;
    }
  }
</style>
