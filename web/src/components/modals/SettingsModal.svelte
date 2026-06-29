<script lang="ts">
  import { untrack } from "svelte";
  import type { PermissionMode, Autonomy, SettingsPatch } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  const snap = $derived(wsStore.snapshot);
  const settings = $derived(snap?.settings);
  const provider = $derived(snap?.provider);

  // The modal is remounted per open, so these intentionally seed once from settings.
  let providerModel = $state(untrack(() => settings?.providerModel ?? provider?.model ?? ""));
  let maxConcurrent = $state(untrack(() => settings?.maxConcurrent ?? 1));
  let budgetMaxTurns = $state<number | "">(untrack(() => settings?.budget.maxTurns ?? ""));
  let budgetMaxMinutes = $state<number | "">(untrack(() => settings?.budget.maxMinutes ?? ""));
  let defaultPermissionMode = $state<PermissionMode>(
    untrack(() => settings?.defaults.permissionMode ?? "acceptEdits"),
  );
  let defaultAutonomy = $state<Autonomy>(untrack(() => settings?.defaults.autonomy ?? "balanced"));

  const baseUrl = $derived(settings?.providerBaseUrl ?? provider?.baseUrl ?? "");
  const providerOk = $derived(!!provider?.ok);

  function save() {
    const settingsPatch: SettingsPatch = {
      providerModel: providerModel.trim(),
      maxConcurrent: Math.max(1, Number(maxConcurrent) || 1),
      budgetMaxTurns: budgetMaxTurns === "" ? null : Number(budgetMaxTurns),
      budgetMaxMinutes: budgetMaxMinutes === "" ? null : Number(budgetMaxMinutes),
      defaultPermissionMode,
      defaultAutonomy,
    };
    wsStore.send({ type: "updateSettings", settings: settingsPatch });
    ui.toast("settings saved");
    ui.closeModal();
  }
</script>

<Modal title="Settings" width={520} onclose={() => ui.closeModal()}>
  {#if !settings}
    <div class="sm-note">
      <Icon name="alert" size={13} />
      Settings unavailable — update the backend. Showing provider info only.
    </div>
  {/if}

  <!-- Brain -->
  <div class="sm-section">
    <div class="sm-head"><Icon name="spark" size={12} /> Brain</div>
    <label for="sm_model">decision model</label>
    <input id="sm_model" bind:value={providerModel} placeholder="qwen3.5:9b" />

    <div class="sm-conn">
      <span class="sm-dot" class:on={providerOk}></span>
      <span class="sm-url">{baseUrl || "no base URL"}</span>
      <span class="sm-state" class:on={providerOk}>{providerOk ? "connected" : "offline"}</span>
    </div>
  </div>

  <!-- Budget -->
  <div class="sm-section">
    <div class="sm-head">Budget (per day)</div>
    <div class="sm-row">
      <div class="sm-col">
        <label for="sm_turns">max turns</label>
        <input
          id="sm_turns"
          type="number"
          inputmode="numeric"
          min="0"
          bind:value={budgetMaxTurns}
          placeholder="no cap"
        />
      </div>
      <div class="sm-col">
        <label for="sm_minutes">max minutes</label>
        <input
          id="sm_minutes"
          type="number"
          inputmode="numeric"
          min="0"
          bind:value={budgetMaxMinutes}
          placeholder="no cap"
        />
      </div>
    </div>
    <p class="sm-explain">Leave empty for no cap.</p>
  </div>

  <!-- Concurrency -->
  <div class="sm-section">
    <div class="sm-head">Concurrency</div>
    <label for="sm_concurrent">max concurrent sessions</label>
    <input
      id="sm_concurrent"
      type="number"
      inputmode="numeric"
      min="1"
      bind:value={maxConcurrent}
      placeholder="1"
    />
    <p class="sm-explain">How many sessions run at once before queuing.</p>
  </div>

  <!-- Defaults -->
  <div class="sm-section">
    <div class="sm-head">Defaults for new sessions</div>
    <label for="sm_perm">permission mode</label>
    <select id="sm_perm" bind:value={defaultPermissionMode}>
      <option value="default">default</option>
      <option value="acceptEdits">acceptEdits</option>
      <option value="auto">auto</option>
      <option value="bypassPermissions">bypassPermissions</option>
    </select>
    <p class="sm-explain">Pre-selected permission mode when you create a session.</p>

    <label for="sm_auto">autonomy</label>
    <select id="sm_auto" bind:value={defaultAutonomy}>
      <option value="cautious">cautious</option>
      <option value="balanced">balanced</option>
      <option value="autonomous">autonomous</option>
    </select>
    <p class="sm-explain">How often the brain escalates a decision to you by default.</p>
  </div>

  <div class="sm-foot">
    <button class="btn btn-sm" onclick={() => ui.closeModal()}>Cancel</button>
    <button class="btn btn-primary btn-sm" onclick={save}>Save</button>
  </div>
</Modal>

<style>
  .sm-section {
    padding: 14px 0;
    border-bottom: 1px solid var(--border-soft);
  }
  .sm-section:first-of-type {
    padding-top: 0;
  }
  .sm-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    color: var(--faint);
    margin-bottom: 4px;
  }

  label {
    display: block;
    font-size: 11px;
    color: var(--color-neutral-content);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 12px 0 5px;
    font-weight: 600;
  }
  input,
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

  .sm-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .sm-col label {
    margin-top: 12px;
  }

  .sm-explain {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin: 6px 2px 0;
    line-height: 1.4;
  }

  .sm-conn {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 9px;
    font-size: 12px;
    color: var(--faint);
  }
  .sm-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-error);
    flex: none;
  }
  .sm-dot.on {
    background: var(--color-primary);
  }
  .sm-url {
    color: var(--color-neutral-content);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sm-state {
    margin-left: auto;
    color: var(--color-error);
    font-weight: 600;
  }
  .sm-state.on {
    color: var(--color-primary);
  }

  .sm-note {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--color-warning);
    background: rgba(251, 191, 36, 0.08);
    border: 1px solid rgba(251, 191, 36, 0.25);
    border-radius: 9px;
    padding: 8px 10px;
    margin-bottom: 14px;
  }

  .sm-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
</style>
