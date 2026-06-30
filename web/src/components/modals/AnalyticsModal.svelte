<script lang="ts">
  import type { Analytics } from "../../lib/types";
  import { api } from "../../lib/api";
  import { ui } from "../../lib/ui.svelte";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  let data = $state<Analytics | null>(null);
  let err = $state("");
  api
    .analytics()
    .then((a) => (data = a))
    .catch((e) => (err = e instanceof Error ? e.message : "failed to load analytics"));

  const pct = (r: number) => `${Math.round(r * 100)}%`;
  function shortGoal(g: string): string {
    const t = g.trim();
    return t.length > 46 ? t.slice(0, 46) + "…" : t;
  }

  // Peak daily turns, for scaling the trend bars.
  let peak = $derived(Math.max(1, ...(data?.daily ?? []).map((d) => d.turns)));

  function download(name: string, text: string, type: string) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    ui.toast(`exported ${name}`);
  }
  function exportJson() {
    if (data) download("agi-analytics.json", JSON.stringify(data, null, 2), "application/json");
  }
  function csvField(v: unknown): string {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function exportCsv() {
    if (!data) return;
    const header = [
      "session", "goal", "runs", "turns", "avg_turns", "completed_runs", "errored_runs",
      "success_rate", "intervention_rate", "decisions_continue", "decisions_stop",
      "decisions_escalate", "thumbs_up", "thumbs_down", "last_run_at",
    ];
    const fleet = ["FLEET", "", data.fleet.runs, data.fleet.turns, data.fleet.avgTurns, "", "", data.fleet.successRate, data.fleet.interventionRate, data.fleet.decisions.continue, data.fleet.decisions.stop, data.fleet.decisions.escalate, data.fleet.feedback.up, data.fleet.feedback.down, ""];
    const rows = data.sessions.map((s) => [s.id, s.goal, s.runs, s.turns, s.avgTurns, s.completedRuns, s.erroredRuns, s.successRate, s.interventionRate, s.decisions.continue, s.decisions.stop, s.decisions.escalate, s.feedback.up, s.feedback.down, s.lastRunAt ? new Date(s.lastRunAt).toISOString() : ""]);
    const csv = [header, fleet, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
    download("agi-analytics.csv", csv, "text/csv");
  }
</script>

<Modal title="Analytics" width={720} onclose={() => ui.closeModal()}>
  {#if err}
    <div class="empty">{err}</div>
  {:else if !data}
    <div class="empty">loading…</div>
  {:else}
    <!-- Fleet headline tiles -->
    <div class="tiles">
      <div class="tile"><div class="v tnum">{data.fleet.runs}</div><div class="k">runs</div></div>
      <div class="tile"><div class="v tnum">{data.fleet.turns}</div><div class="k">turns</div></div>
      <div class="tile"><div class="v tnum">{pct(data.fleet.successRate)}</div><div class="k">success</div></div>
      <div class="tile"><div class="v tnum">{pct(data.fleet.interventionRate)}</div><div class="k">needed you</div></div>
      <div class="tile">
        <div class="v tnum"><span class="up">↑{data.fleet.feedback.up}</span> <span class="down">↓{data.fleet.feedback.down}</span></div>
        <div class="k">thumbs</div>
      </div>
      <div class="tile"><div class="v tnum">{data.learning.totalExamples}</div><div class="k">learned ex.</div></div>
    </div>

    <!-- Daily trend (turns/day) -->
    {#if data.daily.length}
      <div class="section-h">Daily activity <span class="opt">(turns/day)</span></div>
      <div class="trend">
        {#each data.daily as d (d.day)}
          <div class="bar-wrap" title="{d.day}: {d.turns} turns · {d.runs} runs">
            <div class="bar" style="height: {Math.max(4, (d.turns / peak) * 100)}%"></div>
            <span class="bar-lbl">{d.day.slice(5)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Per-session table -->
    <div class="section-h">Per agent</div>
    <div class="tablewrap">
      <table>
        <thead>
          <tr><th class="l">agent</th><th>runs</th><th>turns</th><th>success</th><th>needed you</th><th>decisions (c/s/e)</th><th>thumbs</th></tr>
        </thead>
        <tbody>
          {#each data.sessions as s (s.id)}
            <tr>
              <td class="l"><span class="sid">{s.id}</span><span class="sgoal">{shortGoal(s.goal)}</span></td>
              <td class="tnum">{s.runs}</td>
              <td class="tnum">{s.turns}</td>
              <td class="tnum">{pct(s.successRate)}</td>
              <td class="tnum">{pct(s.interventionRate)}</td>
              <td class="tnum dec">{s.decisions.continue}/{s.decisions.stop}/{s.decisions.escalate}</td>
              <td class="tnum"><span class="up">↑{s.feedback.up}</span> <span class="down">↓{s.feedback.down}</span></td>
            </tr>
          {/each}
          {#if data.sessions.length === 0}
            <tr><td colspan="7" class="empty-row">no runs recorded yet</td></tr>
          {/if}
        </tbody>
      </table>
    </div>

    <div class="facts">
      <span class="genat">as of {new Date(data.generatedAt).toLocaleString()}</span>
      <button class="btn btn-sm" onclick={exportJson}><Icon name="download" size={13} /> JSON</button>
      <button class="btn btn-sm" onclick={exportCsv}><Icon name="download" size={13} /> CSV</button>
      <button class="btn btn-primary btn-sm" onclick={() => ui.closeModal()}>Close</button>
    </div>
  {/if}
</Modal>

<style>
  .tiles {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 16px;
  }
  .tile {
    flex: 1 1 90px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    padding: 10px 12px;
    text-align: center;
  }
  .tile .v {
    font-size: 18px;
    font-weight: 700;
  }
  .tile .k {
    font-size: 10px;
    color: var(--color-neutral-content);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 2px;
  }
  .up {
    color: var(--st-running);
  }
  .down {
    color: var(--st-error);
  }
  .section-h {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    color: var(--faint);
    margin: 14px 0 8px;
  }
  .section-h .opt {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  .trend {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 92px;
    padding: 4px 2px 0;
    border-bottom: 1px solid var(--border-soft);
  }
  .bar-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    gap: 4px;
  }
  .bar {
    width: 100%;
    max-width: 34px;
    background: linear-gradient(180deg, var(--color-primary), rgba(34, 197, 94, 0.35));
    border-radius: 4px 4px 0 0;
    min-height: 4px;
    transition: height 0.2s;
  }
  .bar-lbl {
    font-size: 9px;
    color: var(--faint);
    white-space: nowrap;
  }
  .tablewrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th, td {
    padding: 7px 8px;
    text-align: right;
    border-bottom: 1px solid var(--border-soft);
    white-space: nowrap;
  }
  th {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--faint);
    font-weight: 600;
  }
  th.l, td.l {
    text-align: left;
  }
  .sid {
    display: block;
    font-weight: 600;
    color: var(--color-base-content);
  }
  .sgoal {
    display: block;
    font-size: 11px;
    color: var(--faint);
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dec {
    color: var(--color-neutral-content);
  }
  .empty, .empty-row {
    color: var(--faint);
    padding: 24px;
    text-align: center;
  }
  .facts {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .genat {
    margin-right: auto;
    font-size: 11px;
    color: var(--faint);
  }
</style>
