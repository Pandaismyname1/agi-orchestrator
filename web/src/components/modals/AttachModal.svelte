<script lang="ts">
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { api } from "../../lib/api";

  import type { RunningClaude } from "../../lib/types";

  let sessionId = $state("");
  let goal = $state("");
  let doneCriteria = $state("");
  let err = $state("");
  let busy = $state(false);
  let registered = $state(false);

  let setupEl: HTMLDivElement | undefined;

  // Discover claude processes running on this machine, so the user can attach one
  // with a click instead of hunting for its uuid. Best-effort; failures are silent.
  let running = $state<RunningClaude[]>([]);
  let scanning = $state(true);
  api
    .runningClaude()
    .then((r) => (running = r))
    .catch(() => (running = []))
    .finally(() => (scanning = false));

  // Only the ones we can actually drive: a detectable session id, not already attached.
  let attachable = $derived(running.filter((r) => r.sessionId && !r.attached));

  function pick(r: RunningClaude) {
    if (r.sessionId) sessionId = r.sessionId;
    ui.toast("session id filled — add a goal + done criteria");
  }

  // Basic UUID v1–v5 shape check (the id you'll pass to `claude --session-id`).
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Stop-hook snippet for settings.json — mirrors src/attach/INTEGRATION.md.
  const snippet = `{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node <ABS>/hook/stop-hook.mjs"
          }
        ]
      }
    ]
  }
}`;

  async function submit() {
    err = "";
    const sid = sessionId.trim();
    const g = goal.trim();
    const d = doneCriteria.trim();

    if (!sid || !g || !d) {
      err = "session id, goal, and done criteria are all required.";
      return;
    }
    if (!UUID_RE.test(sid)) {
      err = "that session id doesn't look like a uuid.";
      ui.toast("session id should be a uuid — the one you pass to `claude --session-id`");
      return;
    }

    busy = true;
    try {
      const res = await api.attach({ session_id: sid, goal: g, doneCriteria: d });
      if (res.ok) {
        registered = true;
        ui.toast("attached — now add the Stop hook and start claude with that id");
        // Make sure the setup steps are in view.
        setupEl?.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        err = res.error ?? "attach failed";
        ui.toast(res.error ?? "attach failed");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "attach failed";
      err = msg;
      ui.toast(msg);
    } finally {
      busy = false;
    }
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      ui.toast("copied");
    } catch {
      ui.toast("couldn't copy — select and copy manually");
    }
  }
</script>

<Modal title="Attach a running session" width={560} onclose={() => ui.closeModal()}>
  <p class="lead">
    Drive a <span class="font-mono-term">claude</span> you started by hand. Register its goal here,
    add a <span class="font-mono-term">Stop</span> hook, and the daemon will decide + inject the next
    step each turn. The hook <strong>fails open</strong> — if the daemon is down it never blocks your
    session.
  </p>

  {#if scanning}
    <div class="scanrow"><span class="spin"></span> scanning for running claude sessions…</div>
  {:else if attachable.length}
    <span class="grouplabel">running on this machine <span class="opt">(click to attach)</span></span>
    <div class="runlist" role="group" aria-label="running claude sessions">
      {#each attachable as r (r.pid)}
        <button class="runitem" onclick={() => pick(r)} title={r.commandLine}>
          <span class="runsid">{r.sessionId!.slice(0, 8)}…</span>
          <span class="runpid">pid {r.pid}</span>
          <span class="runcmd">{r.commandLine}</span>
        </button>
      {/each}
    </div>
  {/if}

  <label for="a_sid">session id</label>
  <input
    id="a_sid"
    bind:value={sessionId}
    placeholder="uuid — the id you pass to `claude --session-id`"
    autocomplete="off"
    spellcheck="false"
  />

  <label for="a_goal">goal</label>
  <textarea id="a_goal" bind:value={goal} placeholder="what claude should accomplish"></textarea>

  <label for="a_done">done criteria</label>
  <textarea id="a_done" bind:value={doneCriteria} placeholder="you are done when…"></textarea>

  <div class="ferr">{err}</div>

  <div class="facts">
    <button class="btn btn-sm" onclick={() => ui.closeModal()}>Cancel</button>
    <button class="btn btn-primary btn-sm" onclick={submit} disabled={busy}>
      <Icon name="send" size={14} />
      {busy ? "Registering…" : "Register attach"}
    </button>
  </div>

  <div class="setup" class:done={registered} bind:this={setupEl}>
    <div class="setup-head">
      <Icon name="terminal" size={14} />
      <h3>Set up the Stop hook</h3>
    </div>

    <ol class="steps-list">
      <li>
        Add the snippet below to your Claude <span class="font-mono-term">settings.json</span>
        (<span class="font-mono-term">~/.claude/settings.json</span> or a project
        <span class="font-mono-term">.claude/settings.json</span>). Replace
        <span class="font-mono-term">&lt;ABS&gt;</span> with the absolute path to this repo. On Windows
        escape backslashes (<span class="font-mono-term">\\\\</span>) or use forward slashes.
      </li>
      <li>
        If the dashboard isn't on the default <span class="font-mono-term">http://localhost:4317</span>,
        set <span class="font-mono-term">AGI_DAEMON_URL</span> in the environment claude runs in —
        e.g. <span class="font-mono-term">$env:AGI_DAEMON_URL = "http://localhost:5000"; claude</span>.
      </li>
      <li>
        Start your session with the same id you registered above:
        <span class="font-mono-term">claude --session-id &lt;that-uuid&gt;</span>.
      </li>
    </ol>

    <div class="codewrap">
      <button class="btn btn-sm copy-btn" onclick={copySnippet}>
        <Icon name="download" size={13} /> Copy
      </button>
      <pre class="font-mono-term">{snippet}</pre>
    </div>

    <div class="runline font-mono-term">claude --session-id &lt;that-uuid&gt;</div>
  </div>
</Modal>

<style>
  .lead {
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--color-neutral-content);
    margin: 0 0 4px;
  }
  .lead strong {
    color: var(--color-base-content);
    font-weight: 600;
  }
  .scanrow {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--faint);
    margin-top: 12px;
  }
  .spin {
    width: 12px;
    height: 12px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
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
  .runlist {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 132px;
    overflow-y: auto;
  }
  .runitem {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    font: inherit;
    background: var(--color-base-200);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 7px 10px;
    cursor: pointer;
    transition: border-color 0.13s;
  }
  .runitem:hover {
    border-color: var(--color-primary);
  }
  .runsid {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 600;
    color: var(--color-base-content);
    flex: none;
  }
  .runpid {
    font-size: 10px;
    color: var(--faint);
    flex: none;
  }
  .runcmd {
    font-size: 11px;
    color: var(--faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  input,
  textarea {
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
  textarea:focus {
    outline: none;
    border-color: var(--color-primary);
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
    margin-top: 6px;
  }

  .setup {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid var(--border-soft);
  }
  .setup.done {
    border-top-color: var(--color-primary);
  }
  .setup-head {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--color-secondary);
    margin-bottom: 10px;
  }
  .setup-head h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--color-base-content);
  }

  .steps-list {
    margin: 0 0 12px;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-neutral-content);
  }
  .steps-list li {
    padding-left: 2px;
  }

  .font-mono-term {
    font-size: 0.92em;
    color: var(--color-base-content);
  }

  .codewrap {
    position: relative;
  }
  .copy-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
  }
  pre {
    margin: 0;
    background: var(--term-bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-box);
    padding: 14px 16px;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--color-base-content);
    overflow: auto;
    white-space: pre;
  }

  .runline {
    margin-top: 10px;
    background: var(--term-bg);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-box);
    padding: 10px 14px;
    font-size: 12px;
    color: var(--color-primary);
    overflow: auto;
  }
</style>
