<script lang="ts">
  import { untrack } from "svelte";
  import { fly } from "svelte/transition";
  import type { PermissionMode, Autonomy, SessionMode, SessionInput } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import Icon from "../Icon.svelte";

  interface Props {
    /** When adopting an on-disk session: prefill cwd + carry the resumeId. */
    adopt?: { cwd: string; resumeId: string };
  }
  let { adopt }: Props = $props();

  const STEPS = ["Project", "Mode", "Tune"];
  let step = $state(0);
  let dir = $state(1); // animation direction

  let id = $state("");
  let cwd = $state(untrack(() => adopt?.cwd ?? ""));
  let goal = $state("");
  let doneCriteria = $state("");
  let mode = $state<SessionMode>(untrack(() => (adopt ? "manual" : "autopilot")));
  let permissionMode = $state<PermissionMode>("acceptEdits");
  let autonomy = $state<Autonomy>("balanced");
  let err = $state("");

  let adopting = $derived(!!adopt);
  let canNext = $derived(step !== 0 || (cwd.trim() && goal.trim() && doneCriteria.trim()));

  function next() {
    if (step === 0 && !canNext) {
      err = "cwd, goal, and done criteria are all required.";
      return;
    }
    err = "";
    dir = 1;
    step = Math.min(STEPS.length - 1, step + 1);
  }
  function back() {
    err = "";
    dir = -1;
    step = Math.max(0, step - 1);
  }
  function create() {
    const payload: SessionInput = {
      cwd: cwd.trim(),
      goal: goal.trim(),
      doneCriteria: doneCriteria.trim(),
      permissionMode,
      autonomy,
      startMode: mode,
    };
    if (id.trim()) payload.id = id.trim();
    if (adopt) payload.resumeId = adopt.resumeId;
    wsStore.send({ type: "add", session: payload });
    ui.toast(adopting ? "session adopted" : "session created");
    ui.closeModal();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") ui.closeModal();
  }
  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) ui.closeModal();
  }

  const PERM_HELP: Record<PermissionMode, string> = {
    default: "Claude asks before each action — gates are classified and risky ones escalate to you.",
    acceptEdits: "Auto-accepts file edits; still prompts for shell/network. Good default for autopilot.",
    auto: "Accepts most prompts automatically. Faster, less safe.",
    bypassPermissions: "Never prompts. Only for fully trusted, sandboxed work.",
  };
  const AUTO_HELP: Record<Autonomy, string> = {
    cautious: "Escalates more often — asks you on anything ambiguous.",
    balanced: "Sensible middle ground (recommended).",
    autonomous: "Only stops for truly irreversible calls or missing info.",
  };
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="back" onclick={onBackdrop}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="New session">
    <div class="head">
      <h2>{adopting ? "Adopt existing session" : "New session"}</h2>
      <button class="btn btn-ghost btn-xs btn-square" onclick={() => ui.closeModal()} aria-label="Close">
        <Icon name="x" size={16} />
      </button>
    </div>

    <!-- step indicator -->
    <ol class="wsteps">
      {#each STEPS as label, i (label)}
        <li class:active={i === step} class:done={i < step}>
          <span class="dot">{#if i < step}<Icon name="play" size={11} />{:else}{i + 1}{/if}</span>
          <span class="lbl">{label}</span>
        </li>
      {/each}
    </ol>

    <div class="body">
      {#key step}
        <div class="pane" in:fly={{ x: dir * 18, duration: 180 }}>
          {#if step === 0}
            {#if adopting}
              <div class="hint">resuming {adopt!.resumeId.slice(0, 8)}… — give it a goal and pick a mode</div>
            {/if}
            <label for="w_cwd">Project directory</label>
            <input id="w_cwd" bind:value={cwd} placeholder="C:\path\to\project" />

            <label for="w_goal">Goal</label>
            <textarea id="w_goal" bind:value={goal} placeholder="what claude should accomplish"></textarea>

            <label for="w_done">Done criteria</label>
            <textarea id="w_done" bind:value={doneCriteria} placeholder="you are done when…"></textarea>
          {:else if step === 1}
            <div class="cards">
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="choice" class:on={mode === "manual"} onclick={() => (mode = "manual")}>
                <div class="ctop"><Icon name="hand" size={18} /><b>Manual</b></div>
                <p>You type directly to the agent — seed context first. Qwen stays silent until you flip to autopilot.</p>
              </div>
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="choice" class:on={mode === "autopilot"} onclick={() => (mode = "autopilot")}>
                <div class="ctop"><Icon name="bot" size={18} /><b>Autopilot</b></div>
                <p>Qwen reads each turn and drives toward the goal, escalating to you only when it needs a decision.</p>
              </div>
            </div>
            <div class="note">
              <Icon name="spark" size={13} />
              You can switch modes at any time from the session detail.
            </div>
          {:else}
            <label for="w_id">Label <span class="opt">(optional)</span></label>
            <input id="w_id" bind:value={id} placeholder="auto-generated if blank" />

            <label for="w_perm">Permission mode</label>
            <select id="w_perm" bind:value={permissionMode}>
              <option value="default">default</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="auto">auto</option>
              <option value="bypassPermissions">bypassPermissions</option>
            </select>
            <p class="explain">{PERM_HELP[permissionMode]}</p>

            <label for="w_auto">Autonomy</label>
            <select id="w_auto" bind:value={autonomy}>
              <option value="cautious">cautious</option>
              <option value="balanced">balanced</option>
              <option value="autonomous">autonomous</option>
            </select>
            <p class="explain">{AUTO_HELP[autonomy]}</p>
          {/if}
        </div>
      {/key}
    </div>

    <div class="ferr">{err}</div>

    <div class="foot">
      <button class="btn btn-sm" onclick={back} disabled={step === 0}>Back</button>
      <div class="grow"></div>
      {#if step < STEPS.length - 1}
        <button class="btn btn-primary btn-sm" onclick={next} disabled={!canNext}>
          Next <Icon name="play" size={12} />
        </button>
      {:else}
        <button class="btn btn-primary btn-sm" onclick={create}>
          <Icon name="play" size={13} /> {adopting ? "Adopt & open" : "Create session"}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .back {
    position: fixed;
    inset: 0;
    background: rgba(2, 6, 16, 0.6);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .dialog {
    width: 520px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    background: var(--color-base-100);
    border: 1px solid var(--border-strong);
    border-radius: 16px;
    padding: 20px 22px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
  }
  .head h2 {
    flex: 1;
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .wsteps {
    display: flex;
    align-items: center;
    gap: 8px;
    list-style: none;
    margin: 0 0 18px;
    padding: 0;
  }
  .wsteps li {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--faint);
    font-size: 12px;
    font-weight: 600;
  }
  .wsteps li::after {
    content: "";
    width: 22px;
    height: 1px;
    background: var(--border-strong);
    margin-left: 4px;
  }
  .wsteps li:last-child::after {
    display: none;
  }
  .wsteps .dot {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--color-base-300);
    border: 1px solid var(--border-strong);
    font-size: 11px;
  }
  .wsteps li.active {
    color: var(--color-base-content);
  }
  .wsteps li.active .dot {
    background: var(--color-primary);
    color: var(--color-primary-content);
    border-color: transparent;
  }
  .wsteps li.done {
    color: var(--color-neutral-content);
  }
  .wsteps li.done .dot {
    background: rgba(34, 197, 94, 0.18);
    color: var(--color-primary);
    border-color: rgba(34, 197, 94, 0.4);
  }

  .body {
    position: relative;
    min-height: 196px;
  }
  .pane {
    display: block;
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
  .explain {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin: 6px 2px 0;
    line-height: 1.4;
  }
  .hint {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin-bottom: 10px;
  }

  .cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .choice {
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    padding: 14px;
    cursor: pointer;
    background: var(--color-base-200);
    transition:
      border-color 0.15s,
      background 0.15s,
      transform 0.1s;
  }
  .choice:hover {
    transform: translateY(-2px);
    border-color: var(--border-strong);
  }
  .choice.on {
    border-color: var(--color-primary);
    background: rgba(34, 197, 94, 0.06);
    box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.3);
  }
  .ctop {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .ctop b {
    font-size: 14px;
  }
  .choice p {
    margin: 0;
    font-size: 12px;
    color: var(--color-neutral-content);
    line-height: 1.45;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: 14px;
    font-size: 12px;
    color: var(--faint);
  }

  .ferr {
    color: var(--color-error);
    font-size: 12px;
    min-height: 16px;
    margin-top: 12px;
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .grow {
    flex: 1;
  }
</style>
