<script lang="ts">
  import type { Provider, Budget } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import { pip } from "../lib/pip.svelte";
  import Icon from "./Icon.svelte";
  import BudgetMeter from "./BudgetMeter.svelte";

  interface Props {
    provider: Provider | undefined;
    budget: Budget | null | undefined;
  }
  let { provider, budget }: Props = $props();
</script>

<header>
  <div class="brand">
    <span class="mark"><Icon name="spark" size={17} /></span>
    <div>
      <h1>AGI</h1>
      <div class="sub">autopilot orchestrator</div>
    </div>
  </div>

  <div class="spacer"></div>

  <button class="btn btn-primary btn-sm" onclick={() => wsStore.send({ type: "startAll" })}>
    <Icon name="play" size={13} /> Start all
  </button>
  <button class="btn btn-sm" onclick={() => ui.openModal({ kind: "adopt" })}>
    <Icon name="download" size={13} /> Adopt
  </button>
  <button class="btn btn-sm" onclick={() => ui.openModal({ kind: "new" })}>
    <Icon name="plus" size={13} /> New
  </button>
  <button
    class="btn btn-sm btn-square"
    title={pip.supported ? "Always-on-top status window" : "Needs Chrome/Edge (Document PiP)"}
    disabled={!pip.supported}
    onclick={() => pip.toggle()}
  >
    <Icon name="pip" size={15} />
  </button>

  {#if budget}
    <div class="ml"><BudgetMeter {budget} /></div>
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
  .spacer {
    flex: 1;
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
</style>
