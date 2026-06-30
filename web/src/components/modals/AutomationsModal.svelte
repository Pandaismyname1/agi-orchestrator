<script lang="ts">
  import type {
    AutomationRule,
    AutomationAction,
    AutomationTrigger,
    AutomationInput,
  } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { ago } from "../../lib/format";
  import { summarizeFirings, statsFor, recentFirings, firingLabel } from "../../lib/autohistory";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  let rules = $derived(wsStore.snapshot?.automations ?? []);
  let sessions = $derived(wsStore.snapshot?.sessions ?? []);
  let log = $derived(wsStore.snapshot?.automationLog ?? []);
  let summary = $derived(summarizeFirings(log));
  let recent = $derived(recentFirings(log, 12));
  let webhookNames = $derived((wsStore.snapshot?.webhooks ?? []).filter((w) => w.enabled !== false).map((w) => w.name));

  const ALL_EVENTS: { id: AutomationTrigger; label: string }[] = [
    { id: "done", label: "done" },
    { id: "error", label: "error" },
    { id: "stopped", label: "stopped" },
    { id: "needs-input", label: "needs input" },
    { id: "rate-limited", label: "rate limited" },
  ];

  // "list" = browse/manage; "form" = create or edit one rule.
  let view = $state<"list" | "form">("list");
  let editingId = $state<string | null>(null);
  let err = $state("");

  // Form fields.
  let name = $state("");
  let enabled = $state(true);
  let on = $state<AutomationTrigger[]>([]);
  let mSession = $state("");
  let mMode = $state<"" | "manual" | "autopilot">("");
  let mCwd = $state("");
  let mGoal = $state("");
  let actions = $state<AutomationAction[]>([{ kind: "notify", message: "" }]);

  function resetForm(): void {
    name = "";
    enabled = true;
    on = [];
    mSession = "";
    mMode = "";
    mCwd = "";
    mGoal = "";
    actions = [{ kind: "notify", message: "" }];
    err = "";
  }

  function newRule(): void {
    editingId = null;
    resetForm();
    view = "form";
  }

  function editRule(r: AutomationRule): void {
    editingId = r.id;
    name = r.name ?? "";
    enabled = r.enabled !== false;
    on = [...(r.on ?? [])];
    mSession = r.match?.sessionId ?? "";
    mMode = r.match?.mode ?? "";
    mCwd = r.match?.cwdContains ?? "";
    mGoal = r.match?.goalContains ?? "";
    actions = (r.actions ?? []).length ? r.actions.map((a) => ({ ...a })) : [{ kind: "notify", message: "" }];
    err = "";
    view = "form";
  }

  function backToList(): void {
    view = "list";
    err = "";
  }

  function toggleEvent(e: AutomationTrigger): void {
    on = on.includes(e) ? on.filter((x) => x !== e) : [...on, e];
  }

  function addAction(): void {
    actions = [...actions, { kind: "start", target: "$self" }];
  }
  function removeAction(i: number): void {
    actions = actions.filter((_, idx) => idx !== i);
  }
  function defaultAction(kind: AutomationAction["kind"]): AutomationAction {
    switch (kind) {
      case "notify":
        return { kind: "notify", message: "" };
      case "setMode":
        return { kind: "setMode", target: "$self", mode: "manual" };
      case "sendMessage":
        return { kind: "sendMessage", target: "$self", message: "" };
      case "webhook":
        return { kind: "webhook", webhook: webhookNames[0] ?? "" };
      default:
        return { kind, target: "$self" };
    }
  }
  function setKind(i: number, kind: AutomationAction["kind"]): void {
    actions = actions.map((a, idx) => (idx === i ? defaultAction(kind) : a));
  }
  // Target applies to start/stop/setMode/sendMessage (everything but notify/webhook).
  function setTarget(i: number, target: string): void {
    actions = actions.map((a, idx) =>
      idx === i && a.kind !== "notify" && a.kind !== "webhook" ? { ...a, target } : a,
    );
  }
  // Message applies to notify and sendMessage.
  function setMessage(i: number, message: string): void {
    actions = actions.map((a, idx) =>
      idx === i && (a.kind === "notify" || a.kind === "sendMessage") ? { ...a, message } : a,
    );
  }
  function setActionMode(i: number, mode: "manual" | "autopilot"): void {
    actions = actions.map((a, idx) => (idx === i && a.kind === "setMode" ? { ...a, mode } : a));
  }
  function setWebhook(i: number, webhook: string): void {
    actions = actions.map((a, idx) => (idx === i && a.kind === "webhook" ? { ...a, webhook } : a));
  }

  function save(): void {
    const n = name.trim();
    if (!n) {
      err = "a name is required.";
      return;
    }
    if (actions.length === 0) {
      err = "add at least one action.";
      return;
    }
    for (const a of actions) {
      if ((a.kind === "start" || a.kind === "stop") && !(a.target ?? "").trim()) {
        err = `the ${a.kind} action needs a target session.`;
        return;
      }
    }
    const match: AutomationInput["match"] = {};
    if (mSession) match.sessionId = mSession;
    if (mMode) match.mode = mMode;
    if (mCwd.trim()) match.cwdContains = mCwd.trim();
    if (mGoal.trim()) match.goalContains = mGoal.trim();

    const payload: AutomationInput = {
      name: n,
      enabled,
      on: on.length ? on : undefined,
      match: Object.keys(match).length ? match : undefined,
      actions: actions.map((a) =>
        a.kind === "notify" ? { kind: "notify", message: a.message?.trim() || undefined } : { ...a },
      ),
    };
    if (editingId) payload.id = editingId;
    wsStore.send({ type: "automationSave", automation: payload });
    ui.toast(editingId ? "automation updated" : "automation created");
    backToList();
  }

  function del(r: AutomationRule): void {
    if (!confirm(`Delete the automation "${r.name}"? This can't be undone.`)) return;
    wsStore.send({ type: "automationDelete", id: r.id });
    ui.toast("automation deleted");
  }

  function toggle(r: AutomationRule): void {
    wsStore.send({ type: "automationToggle", id: r.id, enabled: r.enabled === false });
  }

  // ── human-readable summary of a rule for the list ──────────────────────────────
  function eventsLabel(r: AutomationRule): string {
    return r.on && r.on.length ? r.on.join(", ") : "any event";
  }
  function matchLabel(r: AutomationRule): string {
    const m = r.match;
    if (!m) return "any session";
    const parts: string[] = [];
    if (m.sessionId) parts.push(m.sessionId);
    if (m.mode) parts.push(m.mode);
    if (m.cwdContains) parts.push(`cwd~"${m.cwdContains}"`);
    if (m.goalContains) parts.push(`goal~"${m.goalContains}"`);
    return parts.length ? parts.join(" · ") : "any session";
  }
  function actionLabel(a: AutomationAction): string {
    switch (a.kind) {
      case "notify":
        return a.message ? `notify "${a.message}"` : "notify";
      case "setMode":
        return `set ${a.target} → ${a.mode}`;
      case "sendMessage":
        return `message ${a.target}`;
      case "webhook":
        return `webhook "${a.webhook}"`;
      default:
        return `${a.kind} ${a.target}`;
    }
  }
</script>

<Modal title="Automations" width={620} onclose={() => ui.closeModal()}>
  {#if view === "list"}
    <p class="au-intro">
      React to a session's lifecycle event by starting or stopping another session, or firing a
      notification — the unifying layer over webhooks and dependencies. <code>$self</code> means the
      session that fired the event.
    </p>
    {#if rules.length === 0}
      <div class="au-empty">
        No automations yet — add a rule like “when the API build is <b>done</b>, <b>start</b> the
        deploy session,” or “on <b>error</b>, <b>stop</b> it and notify me.”
      </div>
    {:else}
      <div class="au-list">
        {#each rules as r (r.id)}
          <div class="au-row" class:off={r.enabled === false}>
            <div class="au-main">
              <div class="au-name">
                {r.name}
                {#if r.enabled === false}<span class="au-disabled">disabled</span>{/if}
              </div>
              <div class="au-rule">
                <span class="au-when-evt">on {eventsLabel(r)}</span>
                <span class="au-arrow">·</span>
                <span class="au-match">{matchLabel(r)}</span>
              </div>
              <div class="au-badges">
                {#each r.actions as a, ai (ai)}
                  <span class="au-badge au-{a.kind}">{actionLabel(a)}</span>
                {/each}
                {#if statsFor(summary, r.id).count > 0}
                  {@const st = statsFor(summary, r.id)}
                  <span
                    class="au-fired"
                    class:warn={st.lastOutcome !== "ok"}
                    title={`Fired ${st.count}× · last ${ago(st.lastFired)}${st.problems ? ` · ${st.problems} skipped/failed` : ""}`}
                  >
                    <span class="au-dot {st.lastOutcome}"></span>
                    fired {st.count}× · {ago(st.lastFired)}
                  </span>
                {:else}
                  <span class="au-when">never fired · updated {ago(r.updatedAt)}</span>
                {/if}
              </div>
            </div>
            <div class="au-actions">
              <label class="au-switch" title={r.enabled === false ? "Enable" : "Disable"}>
                <input type="checkbox" checked={r.enabled !== false} onchange={() => toggle(r)} />
                <span>on</span>
              </label>
              <button class="btn btn-xs btn-square" aria-label={`Edit ${r.name}`} title="Edit" onclick={() => editRule(r)}>
                <Icon name="edit" size={13} />
              </button>
              <button class="btn btn-xs btn-square au-del" aria-label={`Delete ${r.name}`} title="Delete" onclick={() => del(r)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if recent.length}
      <div class="au-history">
        <div class="au-hhead"><Icon name="clock" size={12} /> Recent activity</div>
        <div class="au-hlist">
          {#each recent as f (f.at + f.ruleId + f.kind + (f.target ?? ""))}
            <div class="au-hrow" class:warn={f.outcome !== "ok"}>
              <span class="au-dot {f.outcome}"></span>
              <span class="au-hname" title={f.ruleName}>{f.ruleName}</span>
              <span class="au-hwhat">{firingLabel(f)}</span>
              <span class="au-hfrom" title={`fired by ${f.from}`}>{f.from}</span>
              {#if f.outcome !== "ok"}<span class="au-hnote">{f.note ?? f.outcome}</span>{/if}
              <span class="au-hago">{ago(f.at)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="au-foot">
      <button class="btn btn-sm" onclick={() => ui.closeModal()}>Close</button>
      <button class="btn btn-primary btn-sm" onclick={newRule}>
        <Icon name="plus" size={13} /> New automation
      </button>
    </div>
  {:else}
    <label for="au_name">Name</label>
    <input id="au_name" bind:value={name} placeholder="e.g. Deploy after API build" />

    <label for="au_events_grp">When the event is</label>
    <div id="au_events_grp" class="au-chips">
      {#each ALL_EVENTS as e (e.id)}
        <label class="au-chk">
          <input type="checkbox" checked={on.includes(e.id)} onchange={() => toggleEvent(e.id)} />
          <span>{e.label}</span>
        </label>
      {/each}
    </div>
    <p class="au-explain">Leave all unchecked to trigger on every event.</p>

    <div class="grouplabel">From a session matching <span class="au-opt">(all optional)</span></div>
    <div class="au-match-grid">
      <select bind:value={mSession} aria-label="Match session id">
        <option value="">any session</option>
        {#each sessions as s (s.id)}
          <option value={s.id}>{s.id}</option>
        {/each}
      </select>
      <select bind:value={mMode} aria-label="Match mode">
        <option value="">any mode</option>
        <option value="autopilot">autopilot</option>
        <option value="manual">manual</option>
      </select>
      <input bind:value={mCwd} placeholder="cwd contains…" aria-label="Match cwd contains" />
      <input bind:value={mGoal} placeholder="goal contains…" aria-label="Match goal contains" />
    </div>

    <div class="grouplabel">Then do</div>
    <div class="au-acts">
      {#each actions as a, i (i)}
        <div class="au-act">
          <select value={a.kind} onchange={(e) => setKind(i, (e.currentTarget as HTMLSelectElement).value as AutomationAction["kind"])} aria-label="Action type">
            <option value="notify">notify</option>
            <option value="start">start</option>
            <option value="stop">stop</option>
            <option value="setMode">set mode</option>
            <option value="sendMessage">send message</option>
            <option value="webhook">run webhook</option>
          </select>
          {#if a.kind === "notify"}
            <input
              value={a.message ?? ""}
              oninput={(e) => setMessage(i, (e.currentTarget as HTMLInputElement).value)}
              placeholder="custom message (optional)"
              aria-label="Notification message"
            />
          {:else if a.kind === "webhook"}
            {#if webhookNames.length}
              <select value={a.webhook} onchange={(e) => setWebhook(i, (e.currentTarget as HTMLSelectElement).value)} aria-label="Webhook to run">
                {#each webhookNames as wn (wn)}
                  <option value={wn}>{wn}</option>
                {/each}
              </select>
            {:else}
              <input
                value={a.webhook}
                oninput={(e) => setWebhook(i, (e.currentTarget as HTMLInputElement).value)}
                placeholder="webhook name (none configured yet)"
                aria-label="Webhook name"
              />
            {/if}
          {:else}
            <select value={a.target} onchange={(e) => setTarget(i, (e.currentTarget as HTMLSelectElement).value)} aria-label="Target session">
              <option value="$self">$self (the firing session)</option>
              {#each sessions as s (s.id)}
                <option value={s.id}>{s.id}</option>
              {/each}
            </select>
            {#if a.kind === "setMode"}
              <select value={a.mode} onchange={(e) => setActionMode(i, (e.currentTarget as HTMLSelectElement).value as "manual" | "autopilot")} aria-label="Target mode">
                <option value="manual">manual</option>
                <option value="autopilot">autopilot</option>
              </select>
            {:else if a.kind === "sendMessage"}
              <input
                value={a.message}
                oninput={(e) => setMessage(i, (e.currentTarget as HTMLInputElement).value)}
                placeholder="message to send"
                aria-label="Message to send"
              />
            {/if}
          {/if}
          <button
            class="btn btn-xs btn-square au-del"
            title="Remove action"
            aria-label="Remove action"
            disabled={actions.length === 1}
            onclick={() => removeAction(i)}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      {/each}
      <button class="btn btn-xs au-addact" onclick={addAction}>
        <Icon name="plus" size={12} /> Add action
      </button>
    </div>

    <label class="au-enable">
      <input type="checkbox" bind:checked={enabled} />
      <span>Enabled</span>
    </label>

    <div class="au-err">{err}</div>
    <div class="au-foot">
      <button class="btn btn-sm" onclick={backToList}>Cancel</button>
      <button class="btn btn-primary btn-sm" onclick={save}>
        {editingId ? "Save changes" : "Create automation"}
      </button>
    </div>
  {/if}
</Modal>

<style>
  .au-intro {
    font-size: 12px;
    color: var(--color-neutral-content);
    line-height: 1.5;
    margin: 0 0 14px;
  }
  .au-intro code {
    font-size: 11px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 5px;
    padding: 0 4px;
  }
  .au-empty {
    color: var(--faint);
    padding: 20px;
    text-align: center;
    line-height: 1.6;
  }
  .au-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .au-row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    padding: 10px 12px;
  }
  .au-row.off {
    opacity: 0.6;
  }
  .au-main {
    flex: 1;
    min-width: 0;
  }
  .au-name {
    font-size: 13px;
    font-weight: 700;
    color: var(--color-base-content);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .au-disabled {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--faint);
    border: 1px solid var(--border-soft);
    border-radius: 20px;
    padding: 1px 7px;
    font-weight: 600;
  }
  .au-rule {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin-top: 3px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .au-when-evt {
    color: var(--st-running);
    font-weight: 600;
  }
  .au-arrow {
    color: var(--faint);
  }
  .au-badges {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .au-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
    color: var(--color-neutral-content);
  }
  .au-badge.au-start {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.4);
  }
  .au-badge.au-stop {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.4);
  }
  .au-when {
    font-size: 11px;
    color: var(--faint);
    margin-left: auto;
  }
  .au-fired {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--color-neutral-content);
    margin-left: auto;
  }
  .au-fired.warn {
    color: var(--st-needs-input, #fbbf24);
  }
  .au-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    background: var(--faint);
  }
  .au-dot.ok {
    background: var(--st-running);
  }
  .au-dot.skipped {
    background: var(--st-needs-input, #fbbf24);
  }
  .au-dot.error {
    background: var(--st-error);
  }

  .au-history {
    margin-top: 16px;
    border-top: 1px solid var(--border-soft);
    padding-top: 12px;
  }
  .au-hhead {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 700;
    color: var(--faint);
    margin-bottom: 8px;
  }
  .au-hlist {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 180px;
    overflow-y: auto;
  }
  .au-hrow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--color-neutral-content);
    padding: 4px 2px;
    border-radius: 6px;
  }
  .au-hrow.warn {
    background: rgba(251, 191, 36, 0.06);
  }
  .au-hname {
    font-weight: 600;
    color: var(--color-base-content);
    max-width: 130px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: none;
  }
  .au-hwhat {
    color: var(--color-neutral-content);
    font-variant-numeric: tabular-nums;
  }
  .au-hfrom {
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 90px;
  }
  .au-hnote {
    color: var(--st-needs-input, #fbbf24);
    font-size: 11px;
  }
  .au-hago {
    margin-left: auto;
    color: var(--faint);
    font-size: 11px;
    flex: none;
  }
  .au-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }
  .au-switch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--faint);
    cursor: pointer;
    margin: 0;
  }
  .au-switch input {
    accent-color: var(--color-primary);
    cursor: pointer;
  }
  .au-del {
    color: var(--color-error);
    border-color: rgba(248, 113, 113, 0.4);
  }
  .au-del:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.1);
    border-color: var(--color-error);
  }

  label,
  .grouplabel {
    display: block;
    font-size: 11px;
    color: var(--color-neutral-content);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 14px 0 5px;
    font-weight: 600;
  }
  .au-opt {
    text-transform: none;
    letter-spacing: 0;
    color: var(--faint);
    font-weight: 400;
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
  .au-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .au-chk,
  .au-enable {
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
  .au-chk input,
  .au-enable input {
    width: auto;
    accent-color: var(--color-primary);
  }
  .au-enable {
    margin-top: 14px;
    width: fit-content;
  }
  .au-explain {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin: 6px 2px 0;
  }
  .au-match-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .au-acts {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .au-act {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .au-act > select:first-child {
    flex: none;
    width: 110px;
  }
  /* every control after the kind select (target / mode / message / webhook),
     except the remove button, shares the remaining width evenly */
  .au-act > input,
  .au-act > select:not(:first-child) {
    flex: 1;
    min-width: 0;
  }
  .au-addact {
    width: fit-content;
  }
  .au-err {
    color: var(--color-error);
    font-size: 12px;
    min-height: 16px;
    margin-top: 10px;
  }
  .au-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }

  @media (max-width: 560px) {
    .au-row {
      flex-direction: column;
    }
    .au-actions {
      align-self: flex-end;
    }
    .au-match-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
