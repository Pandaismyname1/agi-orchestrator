<script lang="ts">
  import { untrack } from "svelte";
  import type {
    PermissionMode,
    Autonomy,
    SessionMode,
    SessionView,
    SessionInput,
    SessionSchedule,
    AutoPrConfig,
  } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import Modal from "../Modal.svelte";

  interface Props {
    /** Provide `session` to edit; or `adopt` {cwd, resumeId} to resume; else new. */
    session?: SessionView;
    adopt?: { cwd: string; resumeId: string };
  }
  let { session, adopt }: Props = $props();

  let editing = $derived(!!session);
  let adopting = $derived(!!adopt);
  // Editing a live session: goal / done / autonomy apply on the next turn; cwd and
  // permission mode are fixed at launch, so they're locked until it's stopped.
  let live = $derived(
    !!session && ["running", "manual", "needs-input", "queued"].includes(session.status),
  );

  // The modal is remounted per open, so these intentionally seed once from props.
  let id = $state(untrack(() => session?.id ?? ""));
  let cwd = $state(untrack(() => session?.cwd ?? adopt?.cwd ?? ""));
  let goal = $state(untrack(() => session?.goal ?? ""));
  let doneCriteria = $state(untrack(() => session?.doneCriteria ?? ""));
  let permissionMode = $state<PermissionMode>(untrack(() => session?.permissionMode ?? "acceptEdits"));
  let autonomy = $state<Autonomy>(untrack(() => session?.autonomy ?? "balanced"));
  let startMode = $state<SessionMode>(untrack(() => session?.mode ?? (adopt ? "manual" : "autopilot")));
  let dependsOn = $state<string[]>(untrack(() => session?.dependsOn ?? []));

  // Auto-start schedule (every N minutes and/or daily HH:MM).
  let schedEnabled = $state(untrack(() => (session?.schedule ? session.schedule.enabled !== false : false)));
  let schedEvery = $state<number | "">(untrack(() => session?.schedule?.everyMinutes ?? ""));
  let schedDaily = $state(untrack(() => session?.schedule?.dailyAt ?? ""));
  function buildSchedule(): SessionSchedule | null {
    const every = typeof schedEvery === "number" && schedEvery >= 1 ? Math.floor(schedEvery) : undefined;
    const daily = /^\d{1,2}:\d{2}$/.test(schedDaily.trim()) ? schedDaily.trim() : undefined;
    if (!every && !daily) return null;
    return { enabled: schedEnabled, everyMinutes: every, dailyAt: daily };
  }

  // Auto-open a PR when the session hits its done-criteria.
  let prMode = $state<"off" | "draft" | "ready">(untrack(() => session?.autoPr?.mode ?? "off"));
  let prBase = $state(untrack(() => session?.autoPr?.base ?? ""));
  function buildAutoPr(): AutoPrConfig | null {
    if (prMode === "off") return null;
    const base = prBase.trim();
    return { mode: prMode, ...(base ? { base } : {}) };
  }

  let err = $state("");

  const title = $derived(editing ? "Edit session" : adopting ? "Adopt existing session" : "New session");

  // All OTHER sessions, selectable as "runs after" dependencies (exclude self).
  let others = $derived((wsStore.snapshot?.sessions ?? []).filter((x) => x.id !== session?.id));
  function depShort(g: string): string {
    const t = g.trim();
    return t.length > 48 ? t.slice(0, 48) + "…" : t;
  }
  function toggleDep(id: string): void {
    dependsOn = dependsOn.includes(id) ? dependsOn.filter((d) => d !== id) : [...dependsOn, id];
  }

  function save() {
    const c = cwd.trim(),
      g = goal.trim(),
      d = doneCriteria.trim();
    if (!c || !g || !d) {
      err = "cwd, goal, and done criteria are all required.";
      return;
    }
    const schedule = buildSchedule();
    const autoPr = buildAutoPr();
    if (editing && session) {
      wsStore.send({
        type: "update",
        id: session.id,
        patch: { cwd: c, goal: g, doneCriteria: d, permissionMode, autonomy, startMode, dependsOn, schedule, autoPr },
      });
    } else {
      const payload: SessionInput = {
        cwd: c,
        goal: g,
        doneCriteria: d,
        permissionMode,
        autonomy,
        startMode,
        dependsOn,
      };
      if (schedule) payload.schedule = schedule;
      if (autoPr) payload.autoPr = autoPr;
      if (id.trim()) payload.id = id.trim();
      if (adopt) payload.resumeId = adopt.resumeId;
      wsStore.send({ type: "add", session: payload });
    }
    ui.closeModal();
  }
</script>

<Modal {title} onclose={() => ui.closeModal()}>
  {#if adopting}
    <div class="hint">resuming {adopt!.resumeId.slice(0, 8)}… — give it a goal and pick a mode</div>
  {/if}

  <label for="f_id">id / label (optional)</label>
  <input id="f_id" bind:value={id} disabled={editing} placeholder="auto-generated if blank" />

  {#if live}
    <div class="livehint">
      ● Live edit — <b>goal</b>, <b>done criteria</b> and <b>autonomy</b> take effect on the next
      turn. cwd and permission mode are locked while it runs.
    </div>
  {/if}

  <label for="f_cwd">cwd (project directory)</label>
  <input id="f_cwd" bind:value={cwd} disabled={live} placeholder="C:\path\to\project" />

  <label for="f_goal">goal</label>
  <textarea id="f_goal" bind:value={goal} placeholder="what claude should accomplish"></textarea>

  <label for="f_done">done criteria</label>
  <textarea id="f_done" bind:value={doneCriteria} placeholder="you are done when…"></textarea>

  <label for="f_perm">permission mode</label>
  <select id="f_perm" bind:value={permissionMode} disabled={live}>
    <option value="default">default</option>
    <option value="acceptEdits">acceptEdits</option>
    <option value="auto">auto</option>
    <option value="bypassPermissions">bypassPermissions</option>
  </select>

  <label for="f_auto">autonomy (how often the brain asks you)</label>
  <select id="f_auto" bind:value={autonomy}>
    <option value="cautious">cautious — asks more</option>
    <option value="balanced">balanced</option>
    <option value="autonomous">autonomous — asks less</option>
  </select>

  <label for="f_mode">start mode</label>
  <select id="f_mode" bind:value={startMode}>
    <option value="autopilot">autopilot — Qwen drives from the goal</option>
    <option value="manual">manual — you seed context first, then flip</option>
  </select>

  <span class="grouplabel" id="f_deps_label">runs after <span class="opt">(optional — waits until these are done)</span></span>
  {#if others.length === 0}
    <div class="hint">no other sessions to depend on yet.</div>
  {:else}
    <div class="depbox" role="group" aria-labelledby="f_deps_label">
      {#each others as o (o.id)}
        <label class="depitem">
          <input
            type="checkbox"
            checked={dependsOn.includes(o.id)}
            onchange={() => toggleDep(o.id)}
          />
          <span class="depname">{o.id}</span>
          <span class="depgoal">{depShort(o.goal)}</span>
        </label>
      {/each}
    </div>
  {/if}

  <span class="grouplabel" id="f_sched_label">schedule <span class="opt">(optional — auto-start on a timer)</span></span>
  <div class="schedbox" role="group" aria-labelledby="f_sched_label">
    <label class="schedtoggle">
      <input type="checkbox" bind:checked={schedEnabled} />
      <span>enabled</span>
    </label>
    <div class="schedrow">
      <div class="schedcol">
        <label for="f_sched_every">every (minutes)</label>
        <input
          id="f_sched_every"
          type="number"
          inputmode="numeric"
          min="1"
          bind:value={schedEvery}
          placeholder="e.g. 60"
        />
      </div>
      <div class="schedcol">
        <label for="f_sched_daily">daily at</label>
        <input id="f_sched_daily" type="time" bind:value={schedDaily} />
      </div>
    </div>
    <p class="schedhint">
      Auto-start runs through the queue — concurrency cap, daily budget, and usage limits still apply.
      Set either field (or both); clear both to remove the schedule.
    </p>
  </div>

  <span class="grouplabel" id="f_pr_label">auto-PR on done <span class="opt">(optional — open a pull request when the goal is met)</span></span>
  <div class="schedbox" role="group" aria-labelledby="f_pr_label">
    <label for="f_pr_mode" class="visually-hidden">auto-PR mode</label>
    <select id="f_pr_mode" bind:value={prMode}>
      <option value="off">off — don't open a PR</option>
      <option value="draft">draft PR — open as a draft</option>
      <option value="ready">ready PR — open for review</option>
    </select>
    {#if prMode !== "off"}
      <div class="prbaserow">
        <label for="f_pr_base">base branch <span class="opt">(optional)</span></label>
        <input id="f_pr_base" bind:value={prBase} placeholder="default branch (e.g. main)" autocomplete="off" spellcheck="false" />
      </div>
      <p class="schedhint">
        On done, the orchestrator commits the agent's changes to an <span class="mono">agi/…</span> branch,
        pushes, and opens the PR. Needs a git repo with an <span class="mono">origin</span> remote and the
        GitHub CLI (<span class="mono">gh</span>) authenticated.
      </p>
    {/if}
  </div>

  <div class="ferr">{err}</div>
  <div class="facts">
    <button class="btn btn-sm" onclick={() => ui.closeModal()}>Cancel</button>
    <button class="btn btn-primary btn-sm" onclick={save}>{editing ? "Save" : "Create"}</button>
  </div>
</Modal>

<style>
  label {
    display: block;
    font-size: 11px;
    color: var(--color-neutral-content);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 13px 0 5px;
    font-weight: 600;
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
    min-height: 54px;
  }
  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--color-primary);
  }
  .hint {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin-bottom: 10px;
  }
  .grouplabel {
    display: block;
    font-size: 11px;
    color: var(--color-neutral-content);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 13px 0 5px;
    font-weight: 600;
  }
  .grouplabel .opt {
    text-transform: none;
    letter-spacing: 0;
    color: var(--faint);
    font-weight: 400;
  }
  .depbox {
    max-height: 148px;
    overflow-y: auto;
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    background: var(--color-base-200);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .depitem {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
    color: var(--color-base-content);
  }
  .depitem:hover {
    background: var(--color-base-300);
  }
  .depitem input[type="checkbox"] {
    width: auto;
    flex: none;
    margin: 0;
    accent-color: var(--color-primary);
    cursor: pointer;
  }
  .depname {
    font-size: 12px;
    font-weight: 600;
    flex: none;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .depgoal {
    font-size: 11px;
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .schedbox {
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    background: var(--color-base-200);
    padding: 10px;
  }
  .schedtoggle {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 0 8px;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 600;
    color: var(--color-base-content);
    cursor: pointer;
  }
  .schedtoggle input {
    width: auto;
    accent-color: var(--color-primary);
    cursor: pointer;
  }
  .schedrow {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .schedcol label {
    margin-top: 0;
  }
  .schedhint {
    font-size: 11px;
    color: var(--faint);
    line-height: 1.45;
    margin: 8px 2px 0;
  }
  .prbaserow {
    margin-top: 10px;
  }
  .prbaserow label {
    margin-top: 0;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--color-base-content);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .livehint {
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-primary);
    background: rgba(34, 197, 94, 0.08);
    border: 1px solid rgba(34, 197, 94, 0.3);
    border-radius: 8px;
    padding: 8px 10px;
    margin-bottom: 4px;
  }
  input:disabled,
  select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ferr {
    color: var(--color-error);
    font-size: 12px;
    min-height: 16px;
    margin-top: 10px;
  }
  .facts {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
</style>
