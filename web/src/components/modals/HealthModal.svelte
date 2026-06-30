<script lang="ts">
  import type { HealthReport } from "../../lib/types";
  import { api } from "../../lib/api";
  import { ui } from "../../lib/ui.svelte";
  import { ago } from "../../lib/format";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  let health = $state<HealthReport | null>(null);
  let failed = $state(false);

  async function load(): Promise<void> {
    failed = false;
    try {
      health = await api.health();
    } catch {
      failed = true;
      health = null;
    }
  }
  void load();

  const STATUS_LABEL: Record<HealthReport["status"], string> = {
    ok: "All systems healthy",
    degraded: "Degraded — needs attention",
    down: "Down — brain unreachable",
  };

  function fmtUptime(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${sec}s`;
  }
  function fmtBytes(b: number): string {
    if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`;
    if (b >= 1 << 10) return `${(b / (1 << 10)).toFixed(1)} KB`;
    return `${b} B`;
  }
</script>

<Modal title="System health" width={500} onclose={() => ui.closeModal()}>
  {#if health === null && !failed}
    <div class="h-empty">checking…</div>
  {:else if failed}
    <div class="h-note">
      <Icon name="alert" size={13} />
      Couldn't reach the backend to read health.
    </div>
  {:else if health}
    <div class="h-banner {health.status}">
      <span class="h-dot {health.status}"></span>
      <b>{STATUS_LABEL[health.status]}</b>
      <button class="btn btn-xs h-refresh" title="Re-check" onclick={load} aria-label="Refresh health">
        <Icon name="spark" size={12} />
      </button>
    </div>

    <div class="h-grid">
      <!-- Brain -->
      <div class="h-card">
        <div class="h-card-head">
          <Icon name="brain" size={13} />
          <span>Local brain</span>
          <span class="h-pill {health.llm.ok ? 'good' : 'bad'}">{health.llm.ok ? "reachable" : "unreachable"}</span>
        </div>
        <div class="h-kv"><span>model</span><b>{health.llm.model}</b></div>
        <div class="h-kv"><span>endpoint</span><b class="mono">{health.llm.baseUrl}</b></div>
        <div class="h-detail">{health.llm.detail}</div>
      </div>

      <!-- Store -->
      <div class="h-card">
        <div class="h-card-head"><Icon name="layers" size={13} /><span>Store</span></div>
        <div class="h-kv"><span>sessions</span><b>{health.db.sessions}</b></div>
        <div class="h-kv"><span>runs recorded</span><b>{health.db.runs}</b></div>
        <div class="h-kv"><span>db size</span><b>{fmtBytes(health.db.sizeBytes)}</b></div>
        <div class="h-detail mono">{health.db.path}</div>
      </div>

      <!-- Fleet -->
      <div class="h-card">
        <div class="h-card-head"><Icon name="bot" size={13} /><span>Fleet</span></div>
        <div class="h-kv"><span>total</span><b>{health.fleet.total}</b></div>
        <div class="h-kv"><span>running</span><b>{health.fleet.running}</b></div>
        <div class="h-kv"><span>needs you</span><b>{health.fleet.needsInput}</b></div>
        <div class="h-kv"><span>errored</span><b class:bad={health.fleet.error > 0}>{health.fleet.error}</b></div>
      </div>

      <!-- Process -->
      <div class="h-card">
        <div class="h-card-head"><Icon name="info" size={13} /><span>Process</span></div>
        <div class="h-kv"><span>version</span><b>{health.version}</b></div>
        <div class="h-kv"><span>uptime</span><b>{fmtUptime(health.uptimeSec)}</b></div>
        <div class="h-kv"><span>checked</span><b>{ago(health.checkedAt)}</b></div>
      </div>
    </div>
  {/if}

  <div class="h-foot">
    <button class="btn btn-sm" onclick={() => ui.closeModal()}>Close</button>
  </div>
</Modal>

<style>
  .h-empty {
    color: var(--faint);
    padding: 24px;
    text-align: center;
  }
  .h-note {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--color-warning);
    background: rgba(251, 191, 36, 0.08);
    border: 1px solid rgba(251, 191, 36, 0.25);
    border-radius: 9px;
    padding: 8px 10px;
  }
  .h-banner {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 13px;
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 14px;
    border: 1px solid var(--border-soft);
  }
  .h-banner.ok {
    background: rgba(34, 197, 94, 0.08);
    border-color: rgba(34, 197, 94, 0.35);
  }
  .h-banner.degraded {
    background: rgba(251, 191, 36, 0.08);
    border-color: rgba(251, 191, 36, 0.35);
  }
  .h-banner.down {
    background: rgba(248, 113, 113, 0.08);
    border-color: rgba(248, 113, 113, 0.4);
  }
  .h-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
  }
  .h-dot.ok {
    background: var(--color-primary);
  }
  .h-dot.degraded {
    background: var(--color-warning);
  }
  .h-dot.down {
    background: var(--color-error);
  }
  .h-refresh {
    margin-left: auto;
  }
  .h-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .h-card {
    border: 1px solid var(--border-soft);
    border-radius: 11px;
    background: var(--color-base-200);
    padding: 11px 12px;
  }
  .h-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 700;
    color: var(--faint);
    margin-bottom: 9px;
  }
  .h-pill {
    margin-left: auto;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
  }
  .h-pill.good {
    color: var(--color-primary);
    border-color: rgba(34, 197, 94, 0.4);
  }
  .h-pill.bad {
    color: var(--color-error);
    border-color: rgba(248, 113, 113, 0.4);
  }
  .h-kv {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    color: var(--color-neutral-content);
    padding: 2px 0;
  }
  .h-kv b {
    color: var(--color-base-content);
    font-weight: 600;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 65%;
  }
  .h-kv b.bad {
    color: var(--color-error);
  }
  .h-detail {
    font-size: 11px;
    color: var(--faint);
    margin-top: 7px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .h-foot {
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
  }
  @media (max-width: 520px) {
    .h-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
