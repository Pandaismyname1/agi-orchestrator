<script lang="ts">
  import { untrack } from "svelte";
  import type { SessionView, SessionMode, ContinuePatch } from "../../lib/types";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  interface Props {
    session: SessionView;
  }
  let { session }: Props = $props();

  // Seeded once from the finished session; the modal remounts per open.
  let instruction = $state("");
  let goal = $state(untrack(() => session.goal));
  let doneCriteria = $state(untrack(() => session.doneCriteria));
  let startMode = $state<SessionMode>(untrack(() => session.mode));

  function go() {
    const patch: ContinuePatch = { goal: goal.trim(), doneCriteria: doneCriteria.trim(), startMode };
    if (instruction.trim()) patch.instruction = instruction.trim();
    wsStore.send({ type: "continue", id: session.id, continue: patch });
    ui.toast("continuing in the same conversation");
    ui.closeModal();
  }
</script>

<Modal title={`Continue · ${session.id}`} width={520} onclose={() => ui.closeModal()}>
  <div class="lead">
    <Icon name="spark" size={13} />
    Resumes the <b>same Claude conversation</b> (its prior context carries over) and sends your next
    instruction. Edit the goal or done-criteria if the direction has changed.
  </div>

  <label for="c_next">Next instruction <span class="opt">(what to do now)</span></label>
  <textarea
    id="c_next"
    bind:value={instruction}
    placeholder="e.g. Now add unit tests and a short README. (leave blank to re-send the goal)"
  ></textarea>

  <label for="c_goal">Goal</label>
  <textarea id="c_goal" bind:value={goal}></textarea>

  <label for="c_done">Done criteria</label>
  <textarea id="c_done" bind:value={doneCriteria}></textarea>

  <label for="c_mode">Resume in</label>
  <select id="c_mode" bind:value={startMode}>
    <option value="autopilot">autopilot — Qwen drives from here</option>
    <option value="manual">manual — you drive, Qwen stays silent</option>
  </select>

  <div class="facts">
    <button class="btn btn-sm" onclick={() => ui.closeModal()}>Cancel</button>
    <button class="btn btn-primary btn-sm" onclick={go}>
      <Icon name="play" size={13} /> Continue
    </button>
  </div>
</Modal>

<style>
  .lead {
    font-size: 12.5px;
    color: var(--color-neutral-content);
    line-height: 1.5;
    margin-bottom: 6px;
    display: flex;
    gap: 7px;
    align-items: flex-start;
  }
  .lead :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--color-primary);
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
  label .opt {
    text-transform: none;
    letter-spacing: 0;
    color: var(--faint);
    font-weight: 400;
  }
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
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--color-primary);
  }
  .facts {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
</style>
