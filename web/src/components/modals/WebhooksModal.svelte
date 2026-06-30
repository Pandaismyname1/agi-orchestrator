<script lang="ts">
  import type { WebhookConfig, WebhookEvent, WebhookInput } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { ago } from "../../lib/format";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  let webhooks = $derived(wsStore.snapshot?.webhooks ?? []);

  const ALL_EVENTS: { id: WebhookEvent; label: string }[] = [
    { id: "done", label: "done" },
    { id: "error", label: "error" },
    { id: "stopped", label: "stopped" },
    { id: "needs-input", label: "needs input" },
    { id: "rate-limited", label: "rate limited" },
  ];

  // "list" = browse/manage; "form" = create or edit one webhook.
  let view = $state<"list" | "form">("list");
  let editingId = $state<string | null>(null);
  let err = $state("");

  // Form fields.
  let name = $state("");
  let url = $state("");
  let format = $state<"json" | "slack" | "discord">("json");
  let events = $state<WebhookEvent[]>([]);
  let enabled = $state(true);

  function resetForm(): void {
    name = "";
    url = "";
    format = "json";
    events = [];
    enabled = true;
    err = "";
  }

  function newWebhook(): void {
    editingId = null;
    resetForm();
    view = "form";
  }

  function editWebhook(w: WebhookConfig): void {
    editingId = w.id;
    name = w.name ?? "";
    url = w.url ?? "";
    format = w.format ?? "json";
    events = [...(w.events ?? [])];
    enabled = w.enabled !== false;
    err = "";
    view = "form";
  }

  function backToList(): void {
    view = "list";
    err = "";
  }

  function toggleEvent(e: WebhookEvent): void {
    events = events.includes(e) ? events.filter((x) => x !== e) : [...events, e];
  }

  function save(): void {
    const n = name.trim();
    const u = url.trim();
    if (!n) {
      err = "a name is required.";
      return;
    }
    if (!/^https?:\/\//i.test(u)) {
      err = "url must start with http:// or https://";
      return;
    }
    const payload: WebhookInput = {
      name: n,
      url: u,
      format,
      events: events.length ? events : undefined,
      enabled,
    };
    if (editingId) payload.id = editingId;
    wsStore.send({ type: "webhookSave", webhook: payload });
    ui.toast(editingId ? "webhook updated" : "webhook created");
    backToList();
  }

  function del(w: WebhookConfig): void {
    if (!confirm(`Delete the webhook "${w.name}"? This can't be undone.`)) return;
    wsStore.send({ type: "webhookDelete", id: w.id });
    ui.toast("webhook deleted");
  }

  function test(w: WebhookConfig): void {
    wsStore.send({ type: "webhookTest", id: w.id });
    ui.toast("sending test…");
  }

  function eventsLabel(w: WebhookConfig): string {
    return w.events && w.events.length ? w.events.join(", ") : "all events";
  }
</script>

<Modal title="Notifications & webhooks" width={580} onclose={() => ui.closeModal()}>
  {#if view === "list"}
    {#if webhooks.length === 0}
      <div class="wh-empty">
        No webhooks yet — add one to get a Slack / Discord / custom ping when a session finishes,
        errors, or needs your decision.
      </div>
    {:else}
      <div class="wh-list">
        {#each webhooks as w (w.id)}
          <div class="wh-row" class:off={w.enabled === false}>
            <div class="wh-main">
              <div class="wh-name">
                {w.name}
                {#if w.enabled === false}<span class="wh-disabled">disabled</span>{/if}
              </div>
              <div class="wh-url">{w.url}</div>
              <div class="wh-badges">
                <span class="wh-badge">{w.format ?? "json"}</span>
                <span class="wh-badge">{eventsLabel(w)}</span>
                <span class="wh-when">updated {ago(w.updatedAt)}</span>
              </div>
            </div>
            <div class="wh-actions">
              <button class="btn btn-xs" title="Send a test payload now" onclick={() => test(w)}>
                <Icon name="send" size={12} /> Test
              </button>
              <button
                class="btn btn-xs btn-square"
                aria-label={`Edit webhook ${w.name}`}
                title="Edit"
                onclick={() => editWebhook(w)}
              >
                <Icon name="edit" size={13} />
              </button>
              <button
                class="btn btn-xs btn-square wh-del"
                aria-label={`Delete webhook ${w.name}`}
                title="Delete"
                onclick={() => del(w)}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="wh-foot">
      <button class="btn btn-sm" onclick={() => ui.closeModal()}>Close</button>
      <button class="btn btn-primary btn-sm" onclick={newWebhook}>
        <Icon name="plus" size={13} /> New webhook
      </button>
    </div>
  {:else}
    <label for="wh_name">Name</label>
    <input id="wh_name" bind:value={name} placeholder="e.g. Slack #builds" />

    <label for="wh_url">Webhook URL</label>
    <input id="wh_url" bind:value={url} placeholder="https://hooks.slack.com/services/…" />

    <label for="wh_format">Format</label>
    <select id="wh_format" bind:value={format}>
      <option value="json">generic JSON (rich payload)</option>
      <option value="slack">Slack (incoming webhook)</option>
      <option value="discord">Discord (webhook)</option>
    </select>

    <label for="wh_events_grp">Fire on</label>
    <div id="wh_events_grp" class="wh-events">
      {#each ALL_EVENTS as e (e.id)}
        <label class="wh-chk">
          <input type="checkbox" checked={events.includes(e.id)} onchange={() => toggleEvent(e.id)} />
          <span>{e.label}</span>
        </label>
      {/each}
    </div>
    <p class="wh-explain">Leave all unchecked to fire on every event.</p>

    <label class="wh-enable">
      <input type="checkbox" bind:checked={enabled} />
      <span>Enabled</span>
    </label>

    <div class="wh-err">{err}</div>
    <div class="wh-foot">
      <button class="btn btn-sm" onclick={backToList}>Cancel</button>
      <button class="btn btn-primary btn-sm" onclick={save}>
        {editingId ? "Save changes" : "Create webhook"}
      </button>
    </div>
  {/if}
</Modal>

<style>
  .wh-empty {
    color: var(--faint);
    padding: 24px;
    text-align: center;
    line-height: 1.5;
  }
  .wh-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .wh-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    padding: 10px 12px;
  }
  .wh-row.off {
    opacity: 0.6;
  }
  .wh-main {
    flex: 1;
    min-width: 0;
  }
  .wh-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--color-base-content);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .wh-disabled {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--faint);
    border: 1px solid var(--border-soft);
    border-radius: 20px;
    padding: 1px 7px;
    font-weight: 600;
  }
  .wh-url {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wh-badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .wh-badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
    color: var(--color-neutral-content);
  }
  .wh-when {
    font-size: 11px;
    color: var(--faint);
    margin-left: auto;
  }
  .wh-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }
  .wh-del {
    color: var(--color-error);
    border-color: rgba(248, 113, 113, 0.4);
  }
  .wh-del:hover {
    background: rgba(248, 113, 113, 0.1);
    border-color: var(--color-error);
  }

  label {
    display: block;
    font-size: 11px;
    color: var(--color-neutral-content);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 13px 0 5px;
    font-weight: 600;
  }
  input:not([type]),
  select {
    width: 100%;
    font: inherit;
    font-size: 13px;
    color: var(--color-base-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    padding: 8px 10px;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .wh-events {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .wh-chk,
  .wh-enable {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--color-base-content);
    text-transform: none;
    letter-spacing: 0;
    margin: 0;
    cursor: pointer;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    padding: 5px 10px;
  }
  .wh-chk input,
  .wh-enable input {
    width: auto;
    accent-color: var(--color-primary);
  }
  .wh-enable {
    margin-top: 13px;
    width: fit-content;
  }

  .wh-explain {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin: 6px 2px 0;
  }
  .wh-err {
    color: var(--color-error);
    font-size: 12px;
    min-height: 16px;
    margin-top: 10px;
  }
  .wh-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }

  @media (max-width: 560px) {
    .wh-row {
      flex-direction: column;
    }
    .wh-actions {
      align-self: flex-end;
    }
  }
</style>
