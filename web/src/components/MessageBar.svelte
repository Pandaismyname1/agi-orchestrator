<script lang="ts">
  import { wsStore } from "../lib/ws.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    sessionId: string;
  }
  let { sessionId }: Props = $props();

  let text = $state("");

  function send() {
    const v = text.trim();
    if (!v) return;
    wsStore.send({ type: "sendMessage", id: sessionId, text: v });
    text = "";
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="msgbar">
  <input
    bind:value={text}
    onkeydown={onKey}
    placeholder="Message the agent directly…"
    aria-label="Message the agent"
  />
  <button class="btn btn-primary btn-sm" onclick={send}>
    <Icon name="send" size={13} /> Send
  </button>
</div>

<style>
  .msgbar {
    display: flex;
    gap: 8px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: rgba(96, 165, 250, 0.06);
  }
  input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-size: 13px;
    color: var(--color-base-content);
    background: var(--color-base-100);
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    padding: 8px 12px;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  input::placeholder {
    color: var(--faint);
  }
  input:focus {
    outline: none;
    border-color: var(--color-secondary);
    box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.18);
  }
  .msgbar :global(.btn) {
    flex: none;
  }
  @media (max-width: 640px) {
    .msgbar {
      padding: 10px 14px;
    }
  }
</style>
