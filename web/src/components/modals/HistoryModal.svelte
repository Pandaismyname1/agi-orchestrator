<script lang="ts">
  import { untrack } from "svelte";
  import type { Metrics, RunRow, RunDetail } from "../../lib/types";
  import { api } from "../../lib/api";
  import { ui } from "../../lib/ui.svelte";
  import { minutes, clamp } from "../../lib/format";
  import Modal from "../Modal.svelte";

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

  async function showRun(id: number) {
    openRunId = id;
    openRun = await api.run(id);
  }
  function backToList() {
    openRun = null;
    openRunId = null;
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
        <div class="tl">
          <div class="you">→ {clamp(t.injected_prompt ?? "", 160)}</div>
          <div class="cl">claude: {clamp((t.assistant_text ?? "").replace(/\s+/g, " "), 220)}</div>
          {#if decLine(decByN.get(t.n))}
            <div class="dec">{decLine(decByN.get(t.n))}</div>
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
