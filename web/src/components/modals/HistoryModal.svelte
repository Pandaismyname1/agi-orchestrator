<script lang="ts">
  import { untrack } from "svelte";
  import type { Metrics, RunRow, RunDetail, TurnDiff } from "../../lib/types";
  import { api } from "../../lib/api";
  import { ui } from "../../lib/ui.svelte";
  import { wsStore } from "../../lib/ws.svelte";
  import { minutes, clamp } from "../../lib/format";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  interface Props {
    sessionId: string;
  }
  let { sessionId }: Props = $props();

  let metrics = $state<Metrics | null>(null);
  let runs = $state<RunRow[]>([]);
  let openRun = $state<RunDetail | null>(null);
  let openRunId = $state<number | null>(null);

  // Fetch once for this modal instance (sessionId is fixed per open).
  const sid = untrack(() => sessionId);
  Promise.all([api.metrics(sid), api.runs(sid)])
    .then(([m, r]) => {
      metrics = m;
      runs = r;
    })
    .catch(() => {});

  // Optimistic overlay of operator thumbs, keyed by turn number, for the open run
  // (the modal fetches once; we don't re-fetch just to reflect a click).
  let fbByN = $state<Record<number, "up" | "down" | null>>({});

  async function showRun(id: number) {
    openRunId = id;
    fbByN = {};
    openRun = await api.run(id);
  }
  function backToList() {
    openRun = null;
    openRunId = null;
    fbByN = {};
  }

  /** Current thumb for turn n — local overlay wins over the fetched value. */
  function fbFor(d: RunDetail["decisions"][number] | undefined): "up" | "down" | null {
    if (!d) return null;
    return d.n in fbByN ? fbByN[d.n] : (d.feedback ?? null);
  }

  /** Toggle a thumb on the decision after turn n; clicking the active one clears it. */
  function rateAt(n: number, current: "up" | "down" | null, thumb: "up" | "down") {
    if (openRunId === null) return;
    const next = current === thumb ? "clear" : thumb;
    fbByN = { ...fbByN, [n]: next === "clear" ? null : next };
    wsStore.send({ type: "decisionFeedbackAt", id: sid, runId: openRunId, n, feedback: next });
  }

  let byStatus = $derived(
    metrics ? Object.entries(metrics.byStatus).map(([k, v]) => `${k} ${v}`).join(" · ") || "—" : "—",
  );

  function decLine(d: RunDetail["decisions"][number] | undefined): string {
    if (!d) return "";
    if (d.action === "continue") return `→ next: ${clamp(d.prompt ?? "", 120)}`;
    if (d.action === "escalate") return `⚑ escalated: ${d.reason ?? ""}`;
    return `■ stop: ${d.reason ?? ""}`;
  }

  /** Parse a turn's stored diff JSON (null/garbage → no diff). */
  function parseDiff(raw: string | null | undefined): TurnDiff | null {
    if (!raw) return null;
    try {
      const d = JSON.parse(raw) as TurnDiff;
      return d && Array.isArray(d.files) ? d : null;
    } catch {
      return null;
    }
  }

  /** Which turns have their diff patch expanded (keyed by turn number). */
  let openDiffs = $state<Record<number, boolean>>({});
  function toggleDiff(n: number) {
    openDiffs = { ...openDiffs, [n]: !openDiffs[n] };
  }
  /** Roll the session's working tree back to the snapshot taken after this turn. */
  function rollback(snapshot: string, turnN: number): void {
    const ok = confirm(
      `Roll the working tree back to the state after turn ${turnN}?\n\n` +
        `This restores files on disk in ${sid} — undoing changes made after this turn. ` +
        `Your current state is backed up first (a notice will show the backup id). The session must be stopped.`,
    );
    if (!ok) return;
    wsStore.send({ type: "rollback", id: sid, snapshot });
    ui.toast("rolling back…");
  }

  /** Classify a patch line for +/- coloring. */
  function lineKind(l: string): "add" | "del" | "hunk" | "meta" | "" {
    if (l.startsWith("+++") || l.startsWith("---")) return "meta";
    if (l.startsWith("@@")) return "hunk";
    if (l.startsWith("diff ") || l.startsWith("index ") || l.startsWith("new file") || l.startsWith("deleted file"))
      return "meta";
    if (l.startsWith("+")) return "add";
    if (l.startsWith("-")) return "del";
    return "";
  }
</script>

{#if openRun}
  {@const decByN = new Map(openRun.decisions.map((d) => [d.n, d]))}
  <Modal title={`run #${openRunId}`} width={620} onclose={() => ui.closeModal()}>
    <div class="back"><button class="backlink" onclick={backToList}>← runs</button></div>
    <div class="events">{openRun.events.map((e) => e.type).join(" → ")}</div>
    {#if openRun.turns.length === 0}
      <div class="empty">no turns recorded</div>
    {:else}
      {#each openRun.turns as t (t.n)}
        {@const td = parseDiff(t.diff)}
        <div class="tl">
          <div class="you">→ {clamp(t.injected_prompt ?? "", 160)}</div>
          <div class="cl">claude: {clamp((t.assistant_text ?? "").replace(/\s+/g, " "), 220)}</div>
          {#if decLine(decByN.get(t.n))}
            {@const cur = fbFor(decByN.get(t.n))}
            <div class="dec">
              <span class="dectext">{decLine(decByN.get(t.n))}</span>
              <span class="rate">
                <button
                  class="thumb up"
                  class:on={cur === "up"}
                  aria-pressed={cur === "up"}
                  aria-label="Good decision"
                  title="Good decision"
                  onclick={() => rateAt(t.n, cur, "up")}
                >
                  <Icon name="thumbsUp" size={12} />
                </button>
                <button
                  class="thumb down"
                  class:on={cur === "down"}
                  aria-pressed={cur === "down"}
                  aria-label="Bad decision"
                  title="Bad decision"
                  onclick={() => rateAt(t.n, cur, "down")}
                >
                  <Icon name="thumbsDown" size={12} />
                </button>
              </span>
            </div>
          {/if}
          {#if td && td.files.length}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="diffhead" onclick={() => toggleDiff(t.n)} title="Show/hide the diff">
              <span class="caret">{openDiffs[t.n] ? "▾" : "▸"}</span>
              <span class="diffcount">{td.files.length} file{td.files.length === 1 ? "" : "s"} changed</span>
              {#each td.files.slice(0, 4) as f (f.file)}
                <span class="fchip">
                  {f.file.split(/[\\/]/).pop()}
                  {#if f.added >= 0}<span class="plus">+{f.added}</span>{/if}
                  {#if f.removed >= 0}<span class="minus">−{f.removed}</span>{/if}
                </span>
              {/each}
              {#if td.files.length > 4}<span class="more">+{td.files.length - 4} more</span>{/if}
              {#if t.snapshot}
                <button
                  class="rollbtn"
                  title="Restore the working tree to the state after this turn"
                  onclick={(e) => {
                    e.stopPropagation();
                    rollback(t.snapshot!, t.n);
                  }}
                >
                  ↩ roll back to here
                </button>
              {/if}
            </div>
            {#if openDiffs[t.n] && td.patch}
              <pre class="patch">{#each td.patch.split("\n") as ln, i (i)}<span class="pl {lineKind(ln)}">{ln + "\n"}</span>{/each}</pre>
              {#if td.truncated}<div class="trunc">diff truncated</div>{/if}
            {/if}
          {/if}
        </div>
      {/each}
    {/if}
  </Modal>
{:else}
  <Modal title={`History · ${sessionId}`} width={580} onclose={() => ui.closeModal()}>
    {#if metrics}
      <div class="metrics">
        <div class="metric"><div class="v tnum">{metrics.runs}</div><div class="k">runs</div></div>
        <div class="metric"><div class="v tnum">{metrics.turns}</div><div class="k">turns</div></div>
        <div class="metric"><div class="v tnum">{metrics.avgTurns}</div><div class="k">avg turns/run</div></div>
        <div class="metric">
          <div class="v tnum">{Math.round((metrics.interventionRate || 0) * 100)}%</div>
          <div class="k">needed you</div>
        </div>
      </div>
      <div class="bystatus">by status: {byStatus}</div>
    {/if}

    {#if runs.length === 0}
      <div class="empty">no runs yet</div>
    {:else}
      {#each runs as r (r.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="row" onclick={() => showRun(r.id)}>
          <span class="sbadge {r.status === 'ended' ? 'done' : r.status}">{r.status}</span>
          <span class="rid">#{r.id}</span>
          <span>turns {r.turns} · {minutes(r.elapsed_min)}</span>
          <span class="reason">{r.stop_reason ?? ""}</span>
        </div>
      {/each}
    {/if}

    <div class="facts">
      <button class="btn btn-sm" onclick={() => ui.closeModal()}>Close</button>
    </div>
  </Modal>
{/if}

<style>
  .metrics {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .metric {
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    padding: 10px 14px;
    min-width: 74px;
  }
  .metric .v {
    font-size: 20px;
    font-weight: 700;
  }
  .metric .k {
    font-size: 10px;
    color: var(--color-neutral-content);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .bystatus {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin-bottom: 10px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 11px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    margin-bottom: 7px;
    cursor: pointer;
  }
  .row:hover {
    border-color: var(--color-primary);
    background: var(--color-base-200);
  }
  .rid {
    color: var(--color-neutral-content);
    font-size: 12px;
  }
  .reason {
    margin-left: auto;
    color: var(--color-neutral-content);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 240px;
  }
  .sbadge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
    color: var(--color-neutral-content);
  }
  .sbadge.done {
    color: var(--st-done);
    border-color: rgba(96, 165, 250, 0.5);
  }
  .sbadge.error {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.5);
  }
  .back {
    margin-bottom: 8px;
  }
  .backlink {
    background: none;
    border: none;
    color: var(--color-primary);
    cursor: pointer;
    padding: 0;
    font: inherit;
  }
  .events {
    font-size: 11px;
    color: var(--color-neutral-content);
    margin-bottom: 12px;
  }
  .tl {
    border-left: 2px solid var(--border-strong);
    padding: 7px 0 7px 13px;
    margin: 0 0 11px;
  }
  .tl .you {
    color: var(--color-secondary);
    font-size: 13px;
  }
  .tl .cl {
    color: var(--color-base-content);
    font-size: 13px;
    margin-top: 3px;
  }
  .tl .dec {
    color: var(--color-neutral-content);
    font-size: 12px;
    margin-top: 5px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dectext {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .rate {
    flex: none;
    display: inline-flex;
    gap: 4px;
  }
  .thumb {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 22px;
    border-radius: 6px;
    border: 1px solid var(--border-soft);
    background: var(--color-base-100);
    color: var(--faint);
    cursor: pointer;
    transition: color 0.13s, border-color 0.13s, background 0.13s;
  }
  .thumb:hover {
    color: var(--color-base-content);
    border-color: var(--border-strong);
  }
  .thumb.up.on {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.55);
    background: rgba(34, 197, 94, 0.1);
  }
  .thumb.down.on {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.55);
    background: rgba(248, 113, 113, 0.1);
  }
  .diffhead {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 7px;
    cursor: pointer;
    font-size: 11px;
    color: var(--color-neutral-content);
  }
  .caret {
    color: var(--faint);
  }
  .diffcount {
    font-weight: 600;
  }
  .fchip {
    font-size: 10px;
    font-family: var(--font-mono, ui-monospace, monospace);
    padding: 1px 7px;
    border: 1px solid var(--border-soft);
    border-radius: 20px;
    color: var(--color-base-content);
  }
  .fchip .plus {
    color: var(--st-running);
    margin-left: 4px;
  }
  .fchip .minus {
    color: var(--st-error);
    margin-left: 3px;
  }
  .more {
    font-size: 10px;
    color: var(--faint);
  }
  .rollbtn {
    margin-left: auto;
    font: inherit;
    font-size: 10px;
    color: var(--st-stopped);
    background: transparent;
    border: 1px solid rgba(251, 191, 36, 0.4);
    border-radius: 20px;
    padding: 1px 9px;
    cursor: pointer;
  }
  .rollbtn:hover {
    background: rgba(251, 191, 36, 0.1);
    border-color: var(--st-stopped);
  }
  .patch {
    margin: 7px 0 0;
    max-height: 300px;
    overflow: auto;
    background: var(--color-base-300);
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    padding: 8px 10px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre;
  }
  .pl {
    display: inline;
  }
  .pl.add {
    color: var(--st-running);
  }
  .pl.del {
    color: var(--st-error);
  }
  .pl.hunk {
    color: var(--color-secondary);
  }
  .pl.meta {
    color: var(--faint);
  }
  .trunc {
    font-size: 10px;
    color: var(--faint);
    margin-top: 3px;
  }
  .empty {
    color: var(--faint);
    padding: 24px;
    text-align: center;
  }
  .facts {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 14px;
  }
</style>
