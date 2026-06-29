<script lang="ts">
  import type { AttentionRequest } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    sessionId: string;
    attention: AttentionRequest;
  }
  let { sessionId, attention }: Props = $props();

  let custom = $state("");
  let isGate = $derived(attention.kind === "gate");

  function pick(optionIndex: number) {
    wsStore.send({ type: "resolve", id: sessionId, choice: { optionIndex } });
  }
  function sendCustom() {
    const v = custom.trim();
    if (!v) {
      ui.toast("type an instruction or pick an option");
      return;
    }
    wsStore.send({ type: "resolve", id: sessionId, choice: { customPrompt: v } });
    custom = "";
  }
  function stop() {
    wsStore.send({ type: "resolve", id: sessionId, choice: { stop: true } });
  }
</script>

<div class="attention" class:gate={isGate}>
  <div class="att-head">
    <span class="att-icon" aria-hidden="true"><Icon name="alert" size={15} /></span>
    <h3>{isGate ? "Risky action — approve?" : "Needs your decision"}</h3>
  </div>
  <div class="q">{attention.question}</div>

  {#each attention.options ?? [] as opt, i (i)}
    <button class="opt" onclick={() => pick(i)}>
      <b>{opt.label}</b>
      {#if opt.rationale}<small>{opt.rationale}</small>{/if}
    </button>
  {/each}

  {#if isGate}
    <div class="row-end">
      <button class="btn btn-error btn-sm" onclick={stop}>Stop run</button>
    </div>
  {:else}
    <div class="custom">
      <textarea bind:value={custom} placeholder="…or type your own instruction"></textarea>
      <div class="col">
        <button class="btn btn-primary btn-sm" onclick={sendCustom}>
          <Icon name="send" size={13} /> Send
        </button>
        <button class="btn btn-error btn-sm" onclick={stop}>Stop run</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .attention {
    margin: 14px 20px;
    padding: 16px 18px;
    border: 1px solid var(--color-warning);
    border-left: 4px solid var(--color-warning);
    border-radius: var(--radius-box);
    background:
      linear-gradient(rgba(251, 191, 36, 0.1), rgba(251, 191, 36, 0.04));
    box-shadow:
      0 0 0 1px rgba(251, 191, 36, 0.12),
      0 8px 26px -10px rgba(251, 191, 36, 0.35);
    animation: att-in 0.34s cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  .att-head {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 10px;
  }
  .att-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    flex: none;
    border-radius: 7px;
    color: var(--color-base-100);
    background: var(--color-warning);
    box-shadow: 0 0 14px -2px rgba(251, 191, 36, 0.6);
  }
  h3 {
    margin: 0;
    font-size: 11.5px;
    color: var(--color-warning);
    text-transform: uppercase;
    letter-spacing: 1.1px;
    font-weight: 800;
  }
  .q {
    font-size: 14.5px;
    font-weight: 600;
    line-height: 1.45;
    color: var(--color-base-content);
    margin-bottom: 14px;
    overflow-wrap: anywhere;
  }
  .opt {
    display: block;
    width: 100%;
    text-align: left;
    margin-bottom: 8px;
    padding: 11px 13px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    cursor: pointer;
    color: var(--color-base-content);
    transition:
      border-color 0.14s,
      background 0.14s,
      transform 0.08s;
  }
  .opt:hover {
    border-color: var(--color-warning);
    background: var(--color-base-300);
  }
  .opt:active {
    transform: translateY(1px);
  }
  .opt:focus-visible {
    outline: 2px solid var(--color-warning);
    outline-offset: 2px;
  }
  .opt b {
    display: block;
    font-size: 13px;
    margin-bottom: 2px;
  }
  .opt small {
    color: var(--color-neutral-content);
    line-height: 1.4;
  }
  .custom {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .custom textarea {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 13px;
    color: var(--color-base-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    padding: 8px 10px;
    resize: vertical;
    min-height: 42px;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  .custom textarea::placeholder {
    color: var(--faint);
  }
  .custom textarea:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .col :global(.btn) {
    white-space: nowrap;
  }
  .row-end {
    display: flex;
    justify-content: flex-end;
  }
  @keyframes att-in {
    0% {
      opacity: 0;
      transform: scale(0.98) translateY(-4px);
      box-shadow:
        0 0 0 3px rgba(251, 191, 36, 0.35),
        0 8px 26px -10px rgba(251, 191, 36, 0.5);
    }
    100% {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .attention {
      animation: none;
    }
  }
  @media (max-width: 640px) {
    .attention {
      margin: 12px 14px;
      padding: 14px;
    }
    .custom {
      flex-direction: column;
    }
    .col {
      flex-direction: row;
    }
    .col :global(.btn) {
      flex: 1;
    }
  }
</style>
