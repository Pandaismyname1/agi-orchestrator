<script lang="ts">
  import { untrack } from "svelte";
  import type { PermissionMode, Autonomy, SessionMode, SessionView, SessionInput } from "../../lib/types";
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
    if (editing && session) {
      wsStore.send({
        type: "update",
        id: session.id,
        patch: { cwd: c, goal: g, doneCriteria: d, permissionMode, autonomy, startMode, dependsOn },
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
