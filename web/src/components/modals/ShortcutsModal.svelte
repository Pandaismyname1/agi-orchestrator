<script lang="ts">
  /**
   * Keyboard-shortcuts cheatsheet. Renders the canonical catalog (shortcuts.ts)
   * grouped into accessible tables of <kbd> chips, with a one-click copy of the
   * whole sheet as plain text. Opened via `?`, the command palette, or a header
   * button — so the fleet keyboard nav is actually discoverable.
   */
  import { SHORTCUT_GROUPS, formatShortcutsText } from "../../lib/shortcuts";
  import { ui } from "../../lib/ui.svelte";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  let copied = $state(false);

  async function copyAll(): Promise<void> {
    const text = formatShortcutsText();
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      ui.toast("shortcuts copied to clipboard");
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard API blocked (insecure context / permission) — fall back to a
      // hidden textarea + execCommand so copy still works.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        copied = true;
        ui.toast("shortcuts copied to clipboard");
        setTimeout(() => (copied = false), 2000);
      } catch {
        ui.toast("couldn't copy — your browser blocked clipboard access");
      }
    }
  }
</script>

<Modal title="Keyboard shortcuts" width={520} onclose={() => ui.closeModal()}>
  <div class="ks-intro">
    <Icon name="keyboard" size={14} />
    <span>Shortcuts work when no text field is focused. Press <kbd>?</kbd> any time to reopen this.</span>
  </div>

  {#each SHORTCUT_GROUPS as group (group.title)}
    <section class="ks-group" aria-labelledby="ks-{group.title}">
      <h3 id="ks-{group.title}">{group.title}</h3>
      <table>
        <tbody>
          {#each group.items as s (s.desc)}
            <tr>
              <td class="ks-keys">
                {#each s.keys as k, i (k)}
                  {#if i > 0}<span class="ks-or">or</span>{/if}
                  <kbd>{k}</kbd>
                {/each}
              </td>
              <td class="ks-desc">{s.desc}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/each}

  <div class="ks-foot">
    <button class="btn btn-sm" class:ok={copied} onclick={copyAll}>
      <Icon name={copied ? "check" : "copy"} size={13} />
      {copied ? "Copied" : "Copy all"}
    </button>
    <button class="btn btn-primary btn-sm" onclick={() => ui.closeModal()}>Done</button>
  </div>
</Modal>

<style>
  .ks-intro {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--color-neutral-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    padding: 8px 11px;
    margin-bottom: 14px;
    line-height: 1.4;
  }
  .ks-group {
    margin-bottom: 14px;
  }
  .ks-group h3 {
    margin: 0 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    color: var(--faint);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  tr {
    border-bottom: 1px solid var(--border-soft);
  }
  tr:last-child {
    border-bottom: none;
  }
  td {
    padding: 7px 0;
    vertical-align: middle;
  }
  .ks-keys {
    width: 42%;
    white-space: nowrap;
  }
  .ks-or {
    font-size: 10px;
    color: var(--faint);
    margin: 0 5px;
  }
  .ks-desc {
    font-size: 13px;
    color: var(--color-base-content);
  }
  kbd {
    display: inline-block;
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1;
    color: var(--color-base-content);
    background: var(--color-base-300);
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 6px;
    padding: 4px 7px;
    min-width: 16px;
    text-align: center;
  }
  .ks-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .ks-foot .ok {
    color: var(--color-primary);
    border-color: rgba(34, 197, 94, 0.5);
  }
</style>
