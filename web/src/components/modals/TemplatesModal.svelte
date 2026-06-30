<script lang="ts">
  import type {
    PermissionMode,
    Autonomy,
    SessionMode,
    SessionTemplate,
    TemplateInput,
  } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { ago } from "../../lib/format";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  let templates = $derived(wsStore.snapshot?.templates ?? []);

  // "list" = browse/manage; "form" = create or edit one template.
  let view = $state<"list" | "form">("list");
  // The template being edited (null = creating a new one).
  let editingId = $state<string | null>(null);
  let err = $state("");

  // Form fields.
  let name = $state("");
  let description = $state("");
  let goal = $state("");
  let doneCriteria = $state("");
  let permissionMode = $state<PermissionMode>("acceptEdits");
  let autonomy = $state<Autonomy>("balanced");
  let startMode = $state<SessionMode>("autopilot");

  function resetForm(): void {
    name = "";
    description = "";
    goal = "";
    doneCriteria = "";
    permissionMode = "acceptEdits";
    autonomy = "balanced";
    startMode = "autopilot";
    err = "";
  }

  function newTemplate(): void {
    editingId = null;
    resetForm();
    view = "form";
  }

  function editTemplate(t: SessionTemplate): void {
    editingId = t.id;
    name = t.name ?? "";
    description = t.description ?? "";
    goal = t.goal ?? "";
    doneCriteria = t.doneCriteria ?? "";
    permissionMode = t.permissionMode ?? "acceptEdits";
    autonomy = t.autonomy ?? "balanced";
    startMode = t.startMode ?? "autopilot";
    err = "";
    view = "form";
  }

  function backToList(): void {
    view = "list";
    err = "";
  }

  function save(): void {
    const n = name.trim();
    if (!n) {
      err = "a template name is required.";
      return;
    }
    const payload: TemplateInput = {
      name: n,
      description: description.trim() || undefined,
      goal: goal.trim() || undefined,
      doneCriteria: doneCriteria.trim() || undefined,
      permissionMode,
      autonomy,
      startMode,
    };
    if (editingId) payload.id = editingId;
    wsStore.send({ type: "templateSave", template: payload });
    ui.toast(editingId ? "template updated" : "template created");
    backToList();
  }

  function del(t: SessionTemplate): void {
    if (!confirm(`Delete the template "${t.name}"? This can't be undone.`)) return;
    wsStore.send({ type: "templateDelete", id: t.id });
    ui.toast("template deleted");
  }

  function use(t: SessionTemplate): void {
    ui.openModal({ kind: "new", template: t });
  }
</script>

<Modal title="Session templates" width={560} onclose={() => ui.closeModal()}>
  {#if view === "list"}
    {#if templates.length === 0}
      <div class="tm-empty">
        No templates yet — create one to pre-fill the New Session wizard.
      </div>
    {:else}
      <div class="tm-list">
        {#each templates as t (t.id)}
          <div class="tm-row">
            <div class="tm-main">
              <div class="tm-name">{t.name}</div>
              {#if t.description}
                <div class="tm-desc">{t.description}</div>
              {/if}
              <div class="tm-badges">
                {#if t.startMode}<span class="tm-badge">{t.startMode}</span>{/if}
                {#if t.permissionMode}<span class="tm-badge">{t.permissionMode}</span>{/if}
                {#if t.autonomy}<span class="tm-badge">{t.autonomy}</span>{/if}
                <span class="tm-when">updated {ago(t.updatedAt)}</span>
              </div>
            </div>
            <div class="tm-actions">
              <button class="btn btn-primary btn-xs" title="Use this template for a new session" onclick={() => use(t)}>
                <Icon name="play" size={12} /> Use
              </button>
              <button
                class="btn btn-xs btn-square"
                aria-label={`Edit template ${t.name}`}
                title="Edit template"
                onclick={() => editTemplate(t)}
              >
                <Icon name="edit" size={13} />
              </button>
              <button
                class="btn btn-xs btn-square tm-del"
                aria-label={`Delete template ${t.name}`}
                title="Delete template"
                onclick={() => del(t)}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="tm-foot">
      <button class="btn btn-sm" onclick={() => ui.closeModal()}>Close</button>
      <button class="btn btn-primary btn-sm" onclick={newTemplate}>
        <Icon name="plus" size={13} /> New template
      </button>
    </div>
  {:else}
    <label for="tm_name">Name</label>
    <input id="tm_name" bind:value={name} placeholder="e.g. Bug-fix autopilot" />

    <label for="tm_desc">Description <span class="opt">(optional)</span></label>
    <input id="tm_desc" bind:value={description} placeholder="short note about when to use this" />

    <label for="tm_goal">Goal <span class="opt">(optional)</span></label>
    <textarea id="tm_goal" bind:value={goal} placeholder="what claude should accomplish"></textarea>

    <label for="tm_done">Done criteria <span class="opt">(optional)</span></label>
    <textarea id="tm_done" bind:value={doneCriteria} placeholder="you are done when…"></textarea>

    <label for="tm_perm">Permission mode</label>
    <select id="tm_perm" bind:value={permissionMode}>
      <option value="default">default</option>
      <option value="acceptEdits">acceptEdits</option>
      <option value="auto">auto</option>
      <option value="bypassPermissions">bypassPermissions</option>
    </select>

    <label for="tm_auto">Autonomy</label>
    <select id="tm_auto" bind:value={autonomy}>
      <option value="cautious">cautious — asks more</option>
      <option value="balanced">balanced</option>
      <option value="autonomous">autonomous — asks less</option>
    </select>

    <label for="tm_mode">Start mode</label>
    <select id="tm_mode" bind:value={startMode}>
      <option value="autopilot">autopilot — Qwen drives from the goal</option>
      <option value="manual">manual — you seed context first, then flip</option>
    </select>

    <div class="tm-err">{err}</div>
    <div class="tm-foot">
      <button class="btn btn-sm" onclick={backToList}>Cancel</button>
      <button class="btn btn-primary btn-sm" onclick={save}>
        {editingId ? "Save changes" : "Create template"}
      </button>
    </div>
  {/if}
</Modal>

<style>
  .tm-empty {
    color: var(--faint);
    padding: 24px;
    text-align: center;
  }
  .tm-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tm-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    padding: 10px 12px;
  }
  .tm-main {
    flex: 1;
    min-width: 0;
  }
  .tm-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--color-base-content);
    overflow-wrap: anywhere;
  }
  .tm-desc {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin-top: 2px;
    overflow-wrap: anywhere;
  }
  .tm-badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .tm-badge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
    color: var(--color-neutral-content);
  }
  .tm-when {
    font-size: 11px;
    color: var(--faint);
    margin-left: auto;
  }
  .tm-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }
  .tm-del {
    color: var(--color-error);
    border-color: rgba(248, 113, 113, 0.4);
  }
  .tm-del:hover {
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
  label:first-child {
    margin-top: 0;
  }
  label .opt {
    text-transform: none;
    letter-spacing: 0;
    color: var(--faint);
    font-weight: 400;
  }
  input,
  textarea,
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
  textarea {
    resize: vertical;
    min-height: 52px;
  }
  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  .tm-err {
    color: var(--color-error);
    font-size: 12px;
    min-height: 16px;
    margin-top: 10px;
  }
  .tm-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }

  @media (max-width: 560px) {
    .tm-row {
      flex-direction: column;
    }
    .tm-actions {
      align-self: flex-end;
    }
  }
</style>
