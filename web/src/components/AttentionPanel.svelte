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

<div class="attention">
  <h3><Icon name="alert" size={13} /> {isGate ? "Risky action — approve?" : "Needs your decision"}</h3>
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
    padding: 15px 17px;
    border: 1px solid var(--color-warning);
    border-left: 4px solid var(--color-warning);
    border-radius: var(--radius-box);
    background: rgba(251, 191, 36, 0.07);
  }
  h3 {
    margin: 0 0 8px;
    font-size: 11px;
    color: var(--color-warning);
    text-transform: uppercase;
    letter-spacing: 1px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .q {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 13px;
  }
  .opt {
    display: block;
    width: 100%;
    text-align: left;
    margin-bottom: 8px;
    padding: 10px 13px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    cursor: pointer;
    color: var(--color-base-content);
  }
  .opt:hover {
    border-color: var(--color-warning);
    background: var(--color-base-300);
  }
  .opt b {
    display: block;
    font-size: 13px;
    margin-bottom: 2px;
  }
  .opt small {
    color: var(--color-neutral-content);
  }
  .custom {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .custom textarea {
    flex: 1;
    font: inherit;
    font-size: 13px;
    color: var(--color-base-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    padding: 8px 10px;
    resize: vertical;
    min-height: 40px;
  }
  .custom textarea:focus {
    outline: none;
    border-color: var(--color-primary);
  }
  .col {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row-end {
    display: flex;
    justify-content: flex-end;
  }
</style>
