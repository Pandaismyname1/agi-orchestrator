<script lang="ts">
  import { untrack } from "svelte";
  import type { PermissionMode, Autonomy, SettingsPatch } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { auth } from "../../lib/auth.svelte";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  // Show the dispatch sign-out only on a remote device that's holding a token.
  const remoteWithToken = $derived(!auth.local && !!auth.token);
  function signOut() {
    ui.closeModal();
    auth.signOut();
  }

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

  // Reliability / self-healing tuning.
  let relRetries = $state<number | "">(untrack(() => settings?.reliability?.retries ?? 3));
  let relBackoffMs = $state<number | "">(untrack(() => settings?.reliability?.retryBackoffMs ?? 400));
  let relPollSeconds = $state<number | "">(untrack(() => settings?.reliability?.brainPollSeconds ?? 15));

  // Workflow depth cap — sequential steps before the next auto-step needs manual review.
  let depthCap = $state<number | "">(untrack(() => settings?.workflowDepthCap ?? 10));

  // Quiet hours (notification schedule).
  const qh = untrack(() => settings?.quietHours ?? null);
  let qhEnabled = $state(!!qh && qh.enabled !== false);
  let qhStart = $state(qh?.start ?? "22:00");
  let qhEnd = $state(qh?.end ?? "07:00");
  let qhAllowUrgent = $state(!!qh?.allowUrgent);
  let qhDays = $state<number[]>(qh?.days ? [...qh.days] : []);
  const quietActive = $derived(!!snap?.quietActive);
  const DAYS = [
    { d: 1, l: "Mon" },
    { d: 2, l: "Tue" },
    { d: 3, l: "Wed" },
    { d: 4, l: "Thu" },
    { d: 5, l: "Fri" },
    { d: 6, l: "Sat" },
    { d: 0, l: "Sun" },
  ];
  function toggleDay(d: number): void {
    qhDays = qhDays.includes(d) ? qhDays.filter((x) => x !== d) : [...qhDays, d];
  }

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
    if (relRetries !== "") settingsPatch.reliabilityRetries = Math.max(0, Number(relRetries) || 0);
    if (relBackoffMs !== "") settingsPatch.reliabilityBackoffMs = Math.max(50, Number(relBackoffMs) || 400);
    if (relPollSeconds !== "") settingsPatch.reliabilityPollSeconds = Math.max(5, Number(relPollSeconds) || 15);
    // "" → null resets to the default cap; 0 disables the guard; else floor at >= 0.
    settingsPatch.workflowDepthCap = depthCap === "" ? null : Math.max(0, Math.floor(Number(depthCap) || 0));
    settingsPatch.quietHours = qhEnabled
      ? {
          enabled: true,
          start: qhStart,
          end: qhEnd,
          days: qhDays.length ? qhDays : undefined,
          allowUrgent: qhAllowUrgent || undefined,
        }
      : null;
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

  <!-- Reliability -->
  <div class="sm-section">
    <div class="sm-head"><Icon name="bot" size={12} /> Reliability (self-healing)</div>
    <div class="sm-row">
      <div class="sm-col">
        <label for="sm_retries">brain retries</label>
        <input id="sm_retries" type="number" inputmode="numeric" min="0" max="10" bind:value={relRetries} placeholder="3" />
      </div>
      <div class="sm-col">
        <label for="sm_backoff">retry backoff (ms)</label>
        <input id="sm_backoff" type="number" inputmode="numeric" min="50" bind:value={relBackoffMs} placeholder="400" />
      </div>
    </div>
    <label for="sm_poll">health-poll while paused (seconds)</label>
    <input id="sm_poll" type="number" inputmode="numeric" min="5" max="300" bind:value={relPollSeconds} placeholder="15" />
    <p class="sm-explain">
      Transient brain-call failures retry with doubling backoff; if the local model goes unreachable the
      run auto-pauses and re-checks at this cadence. Retry changes apply on the next start; the poll
      interval applies to the next run.
    </p>
  </div>

  <!-- Workflow -->
  <div class="sm-section">
    <div class="sm-head"><Icon name="layers" size={12} /> Workflow</div>
    <label for="sm_depth">depth cap (steps before manual review)</label>
    <input id="sm_depth" type="number" inputmode="numeric" min="0" max="100" bind:value={depthCap} placeholder="10" />
    <p class="sm-explain">
      A dependency chain auto-runs up to this many sequential steps; the next step then pauses as
      “needs review” for you to start by hand. The builder also warns when a drawn edge would exceed
      it. 0 disables the guard (auto-run chains of any depth); blank resets to the default (10).
    </p>
  </div>

  <!-- Quiet hours -->
  <div class="sm-section">
    <div class="sm-head">
      <Icon name="moon" size={12} /> Quiet hours
      {#if quietActive}<span class="qh-live">silenced now</span>{/if}
    </div>
    <label class="qh-toggle" for="sm_qh">
      <input id="sm_qh" type="checkbox" bind:checked={qhEnabled} />
      <span>Silence alerts &amp; webhooks during a daily window</span>
    </label>

    {#if qhEnabled}
      <div class="sm-row">
        <div class="sm-col">
          <label for="sm_qh_start">from</label>
          <input id="sm_qh_start" type="time" bind:value={qhStart} />
        </div>
        <div class="sm-col">
          <label for="sm_qh_end">to</label>
          <input id="sm_qh_end" type="time" bind:value={qhEnd} />
        </div>
      </div>

      <div class="fieldlabel">days (none = every day)</div>
      <div class="qh-days">
        {#each DAYS as d (d.d)}
          <button
            type="button"
            class="qh-day"
            class:on={qhDays.includes(d.d)}
            aria-pressed={qhDays.includes(d.d)}
            onclick={() => toggleDay(d.d)}>{d.l}</button
          >
        {/each}
      </div>

      <label class="qh-toggle" for="sm_qh_urgent">
        <input id="sm_qh_urgent" type="checkbox" bind:checked={qhAllowUrgent} />
        <span>Still alert me on <b>errors</b> during quiet hours</span>
      </label>
      <p class="sm-explain">
        An end earlier than the start spans midnight (e.g. 22:00 → 07:00). Times are your local
        clock. This gates the sound alarm and outbound webhooks; it never changes fleet automations.
      </p>
    {/if}
  </div>

  {#if remoteWithToken}
    <div class="sm-section">
      <div class="sm-head"><Icon name="plug" size={12} /> Dispatch (this device)</div>
      <p class="sm-explain">
        You're connected remotely with a saved access token. Sign out to forget it on this device.
      </p>
      <button class="btn btn-sm signout" onclick={signOut}>Sign out of dispatch</button>
    </div>
  {/if}

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

  .qh-live {
    margin-left: auto;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.4px;
    color: var(--st-needs-input, #fbbf24);
    background: rgba(251, 191, 36, 0.12);
    border: 1px solid rgba(251, 191, 36, 0.35);
    border-radius: 20px;
    padding: 1px 8px;
    text-transform: none;
  }
  .qh-toggle {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 10px 0 2px;
    font-size: 13px;
    color: var(--color-base-content);
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
    cursor: pointer;
  }
  .qh-toggle input {
    width: auto;
    accent-color: var(--color-primary);
    cursor: pointer;
  }
  .qh-toggle b {
    color: var(--color-base-content);
    font-weight: 700;
  }
  .fieldlabel {
    font-size: 11px;
    color: var(--color-neutral-content);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 12px 0 5px;
    font-weight: 600;
  }
  .qh-days {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 5px;
  }
  .qh-day {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-neutral-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 5px 10px;
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s, background 0.12s;
  }
  .qh-day:hover {
    color: var(--color-base-content);
    border-color: var(--color-neutral-content);
  }
  .qh-day.on {
    color: var(--color-primary);
    border-color: rgba(34, 197, 94, 0.5);
    background: rgba(34, 197, 94, 0.12);
  }

  .sm-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .signout {
    color: var(--color-error);
    border-color: rgba(248, 113, 113, 0.4);
  }
  .signout:hover {
    border-color: var(--color-error);
  }
</style>
