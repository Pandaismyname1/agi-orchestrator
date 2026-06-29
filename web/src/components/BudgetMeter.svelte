<script lang="ts">
  import type { Budget } from "../lib/types";

  interface Props {
    budget: Budget;
  }
  let { budget }: Props = $props();

  let ratio = $derived(
    Math.max(
      budget.maxTurns ? budget.turns / budget.maxTurns : 0,
      budget.maxMinutes ? budget.minutes / budget.maxMinutes : 0,
    ),
  );
  let level = $derived(budget.exceeded ? "over" : ratio >= 0.8 ? "warn" : "ok");
  let label = $derived(
    `${budget.turns}${budget.maxTurns ? "/" + budget.maxTurns : ""}t · ` +
      `${Math.round(budget.minutes)}${budget.maxMinutes ? "/" + budget.maxMinutes : ""}m`,
  );
</script>

<div class="budget" title="Today's usage against the daily cap">
  <div class="lbl">
    <span>today</span>
    <b class="tnum">{label}</b>
  </div>
  <div class="meter {level}">
    <span style="width:{Math.min(100, Math.round(ratio * 100))}%"></span>
  </div>
</div>

<style>
  .budget {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 150px;
  }
  .lbl {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: var(--color-neutral-content);
  }
  .lbl b {
    font-weight: 600;
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
    transition:
      width 0.4s ease,
      background 0.3s;
  }
  .warn > span {
    background: var(--color-warning);
  }
  .over > span {
    background: var(--color-error);
  }
</style>
