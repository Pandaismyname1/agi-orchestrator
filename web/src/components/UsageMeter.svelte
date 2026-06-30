<script lang="ts">
  import type { UsageStatus, LimitWindow } from "../lib/types";

  interface Props {
    usage: UsageStatus;
  }
  let { usage }: Props = $props();

  const rows = $derived(
    (
      [
        ["session", "session", usage.session],
        ["week", "week", usage.weeklyAll],
        ["sonnet", "sonnet", usage.weeklySonnet],
      ] as [string, string, LimitWindow | undefined][]
    ).filter(([, , w]) => !!w),
  );

  function level(pct: number): "ok" | "warn" | "over" {
    return pct >= 100 ? "over" : pct >= 80 ? "warn" : "ok";
  }

  /** "2h10m" until a reset, or "" if unknown/past. */
  function until(resetAt?: number): string {
    if (!resetAt) return "";
    const ms = resetAt - Date.now();
    if (ms <= 0) return "soon";
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000); // floor avoids "…h60m"
    return h > 0 ? `${h}h${m}m` : `${m}m`;
  }
</script>

<div class="usage" title="Claude's real subscription limits (from /usage)">
  {#each rows as [key, label, w] (key)}
    <div class="row">
      <span class="k">{label}</span>
      <div class="meter {level(w!.pct)}">
        <span style="width:{Math.min(100, w!.pct)}%"></span>
      </div>
      <span class="pct tnum">{w!.pct}%</span>
      {#if w!.resetAt}<span class="rst tnum" title={w!.resetText}>{until(w!.resetAt)}</span>{/if}
    </div>
  {/each}
</div>

<style>
  .usage {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 168px;
  }
  .row {
    display: grid;
    grid-template-columns: 46px 1fr 30px 34px;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    color: var(--color-neutral-content);
  }
  .k {
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-weight: 600;
    color: var(--faint);
  }
  .meter {
    height: 5px;
    border-radius: 4px;
    background: var(--color-base-300);
    overflow: hidden;
  }
  .meter > span {
    display: block;
    height: 100%;
    border-radius: 4px;
    background: var(--color-primary);
    transition: width 0.4s ease, background 0.3s;
  }
  .warn > span {
    background: var(--color-warning);
  }
  .over > span {
    background: var(--color-error);
  }
  .pct {
    text-align: right;
    font-weight: 600;
    color: var(--color-base-content);
  }
  .rst {
    text-align: right;
    color: var(--faint);
  }
</style>
