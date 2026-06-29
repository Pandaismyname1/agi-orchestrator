<script lang="ts">
  import type { Provider, Budget, SessionView } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import { pip } from "../lib/pip.svelte";
  import Icon from "./Icon.svelte";
  import BudgetMeter from "./BudgetMeter.svelte";

  interface Props {
    provider: Provider | undefined;
    budget: Budget | null | undefined;
    sessions: SessionView[];
  }
  let { provider, budget, sessions }: Props = $props();

  let needsYou = $derived(sessions.filter((s) => s.status === "needs-input"));
  let running = $derived(sessions.filter((s) => s.status === "running" || s.status === "manual").length);

  function jumpToNeedsYou() {
    const target = needsYou[0];
    if (!target) return;
    ui.focusId = target.id;
    wsStore.send({ type: "focus", id: target.id });
  }
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

  {#if needsYou.length > 0}
    <button class="needsyou" onclick={jumpToNeedsYou}>
      <Icon name="alert" size={14} />
      {needsYou.length} {needsYou.length === 1 ? "needs" : "need"} you
    </button>
  {/if}

  <button class="btn btn-primary btn-sm" onclick={() => wsStore.send({ type: "startAll" })}>
    <Icon name="play" size={13} /> Start all
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
    class="btn btn-sm btn-square"
    title="Settings — provider, budget, concurrency, defaults"
    onclick={() => ui.openModal({ kind: "settings" })}
  >
    <Icon name="settings" size={15} />
  </button>

  {#if budget}
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
  .needsyou {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 700;
    color: var(--color-accent-content);
    background: var(--color-warning);
    border: 1px solid var(--color-warning);
    border-radius: 9px;
    padding: 6px 12px;
    cursor: pointer;
    animation: nag 1.1s ease-in-out infinite;
  }
  .needsyou:hover {
    filter: brightness(1.05);
  }
  @keyframes nag {
    0%,
    100% {
      box-shadow: 0 0 0 0 rgba(251, 191, 36, 0.5);
    }
    50% {
      box-shadow: 0 0 0 5px rgba(251, 191, 36, 0);
    }
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
