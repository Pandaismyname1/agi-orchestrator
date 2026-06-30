<script lang="ts">
  /**
   * Persistent conversation view for a session, reconstructed from SQLite via
   * /api (so it survives the live PTY exiting). Shows, per turn: what was sent to
   * Claude (the goal, a Qwen-generated step, or your manual message), Claude's
   * reply, and Qwen's decision. Defaults to the latest run; older runs selectable.
   */
  import type { RunRow, RunDetail, DecisionRow } from "../lib/types";
  import { api } from "../lib/api";
  import { minutes } from "../lib/format";
  import Icon from "./Icon.svelte";

  interface Props {
    sessionId: string;
    /** Bump to refetch (e.g. `${status}:${turns}`) as turns land / the run ends. */
    reloadKey?: unknown;
  }
  let { sessionId, reloadKey }: Props = $props();

  let runs = $state<RunRow[]>([]);
  // "all" merges every run into one chronological history (the default); a number
  // shows a single run.
  let selected = $state<number | "all">("all");
  let details = $state<RunDetail[]>([]);
  let loading = $state(true);
  let failed = $state(false);

  async function load(): Promise<void> {
    loading = true;
    failed = false;
    try {
      runs = await api.runs(sessionId); // newest first
      if (!runs.length) {
        details = [];
        return;
      }
      if (selected !== "all" && !runs.some((r) => r.id === selected)) selected = "all";
      if (selected === "all") {
        const all = await Promise.all(runs.map((r) => api.run(r.id)));
        // Oldest run first so the merged history reads top-to-bottom in time.
        details = all.filter((d): d is RunDetail => !!d).sort((a, b) => (a.run?.id ?? 0) - (b.run?.id ?? 0));
      } else {
        const one = await api.run(selected);
        details = one ? [one] : [];
      }
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  // Refetch whenever the session or its progress changes.
  let lastKey = "";
  $effect(() => {
    const key = `${sessionId}:${String(reloadKey)}:${selected}`;
    if (key !== lastKey) {
      lastKey = key;
      void load();
    }
  });

  function pick(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    selected = v === "all" ? "all" : Number(v);
    void load();
  }

  type Row = RunDetail["turns"][number] & {
    source: "goal" | "qwen" | "you";
    decision: DecisionRow | null;
  };
  interface RunBlock {
    id: number;
    meta: string;
    stopReason?: string;
    rows: Row[];
  }

  // The first turn is the goal seed; a later turn whose prompt matches the prior
  // decision's prompt came from Qwen (autopilot); otherwise you typed it (manual).
  function rowsFor(detail: RunDetail): Row[] {
    const decByN = new Map(detail.decisions.map((d) => [d.n, d]));
    return detail.turns.map((t) => {
      const prev = decByN.get(t.n - 1);
      const source: Row["source"] =
        t.n === 1 ? "goal" : prev?.prompt && prev.prompt === t.injected_prompt ? "qwen" : "you";
      return { ...t, source, decision: decByN.get(t.n) ?? null };
    });
  }

  let blocks = $derived.by((): RunBlock[] =>
    details.map((d) => ({
      id: d.run?.id ?? 0,
      meta: `run #${d.run?.id ?? "?"} · ${d.turns.length}t${d.run?.elapsed_min ? " · " + minutes(d.run.elapsed_min) : ""}`,
      stopReason: d.run?.stop_reason ?? undefined,
      rows: rowsFor(d),
    })),
  );
  let totalTurns = $derived(blocks.reduce((n, b) => n + b.rows.length, 0));
  // Show per-run dividers only when more than one run is in view.
  let showDividers = $derived(blocks.length > 1);

  const SRC_LABEL: Record<Row["source"], string> = { goal: "Goal", qwen: "Qwen", you: "You" };
</script>

<div class="transcript">
  <div class="thead">
    <span class="tlabel"><Icon name="clock" size={13} /> Transcript</span>
    {#if runs.length > 1}
      <select class="runsel" onchange={pick} value={String(selected)}>
        <option value="all">All runs · {runs.length} runs</option>
        {#each runs as r (r.id)}
          <option value={r.id}>run #{r.id} · {r.turns}t · {minutes(r.elapsed_min)}</option>
        {/each}
      </select>
    {:else if runs.length === 1}
      <span class="runmeta">run #{runs[0].id}</span>
    {/if}
    {#if totalTurns > 0}
      <span class="runmeta turns">{totalTurns} turns</span>
    {/if}
  </div>

  <div class="tbody">
    {#if loading}
      <div class="note">loading conversation…</div>
    {:else if failed}
      <div class="note">couldn't load the transcript.</div>
    {:else if totalTurns === 0}
      <div class="note">
        <Icon name="terminal" size={28} />
        <p>No conversation recorded yet. Runs started from the dashboard are saved here.</p>
      </div>
    {:else}
      {#each blocks as block, bi (bi)}
        {#if showDividers}
          <div class="rundiv">
            <span class="rd-label">{block.meta}</span>
            {#if block.stopReason}<span class="rd-stop" title={block.stopReason}>{block.stopReason}</span>{/if}
          </div>
        {/if}
        {#each block.rows as turn (turn.n)}
          <div class="turn">
            <div class="bubble sent {turn.source}">
              <div class="who">{SRC_LABEL[turn.source]}<span class="tn">turn {turn.n}</span></div>
              <div class="text">{turn.injected_prompt ?? ""}</div>
            </div>

            <div class="bubble claude">
              <div class="who">Claude</div>
              <div class="text">{turn.assistant_text ?? ""}</div>
            </div>

            {#if turn.decision}
              <div class="brainrow {turn.decision.action}">
                <Icon name="bot" size={12} />
                <span class="ba">Qwen · {turn.decision.action}</span>
                {#if turn.decision.reason}<span class="br">{turn.decision.reason}</span>{/if}
              </div>
            {/if}
          </div>
        {/each}
      {/each}
    {/if}
  </div>
</div>

<style>
  .transcript {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .thead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--color-base-100);
  }
  .tlabel {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-weight: 700;
    color: var(--color-neutral-content);
  }
  .runsel {
    font: inherit;
    font-size: 12px;
    color: var(--color-base-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    padding: 3px 8px;
  }
  .runmeta {
    font-size: 12px;
    color: var(--faint);
  }
  .runmeta.turns {
    margin-left: auto;
  }
  .rundiv {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 4px 0 14px;
    padding-bottom: 6px;
    border-bottom: 1px dashed var(--border-soft);
  }
  .rd-label {
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    color: var(--color-neutral-content);
  }
  .rd-stop {
    margin-left: auto;
    font-size: 11px;
    color: var(--color-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 55%;
  }
  .tbody {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 20px;
  }
  .turn {
    margin-bottom: 18px;
  }
  .bubble {
    border: 1px solid var(--border-soft);
    border-left-width: 3px;
    border-radius: 10px;
    padding: 9px 12px;
    margin-bottom: 8px;
    background: var(--color-base-200);
  }
  .bubble .who {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 700;
    margin-bottom: 5px;
  }
  .bubble .tn {
    color: var(--faint);
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
  }
  .bubble .text {
    font-size: 13px;
    line-height: 1.55;
    color: var(--color-base-content);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .sent {
    border-left-color: var(--color-secondary);
  }
  .sent .who {
    color: var(--color-secondary);
  }
  .sent.qwen {
    border-left-color: var(--color-primary);
  }
  .sent.qwen .who {
    color: var(--color-primary);
  }
  .sent.goal {
    border-left-color: var(--faint);
  }
  .sent.goal .who {
    color: var(--color-neutral-content);
  }
  .claude {
    border-left-color: var(--border-strong);
    background: var(--color-base-100);
  }
  .claude .who {
    color: var(--color-neutral-content);
  }
  .brainrow {
    display: flex;
    align-items: baseline;
    gap: 7px;
    padding: 4px 2px 0 12px;
    font-size: 12px;
    color: var(--color-neutral-content);
  }
  .brainrow .ba {
    color: var(--color-primary);
    font-weight: 600;
    flex: none;
  }
  .brainrow.stop .ba {
    color: var(--color-warning);
  }
  .brainrow .br {
    overflow-wrap: anywhere;
  }
  .note {
    color: var(--faint);
    text-align: center;
    padding: 40px 24px;
    font-size: 13px;
  }
  .note :global(svg) {
    margin: 0 auto 10px;
    opacity: 0.45;
  }
  .note p {
    margin: 0;
    max-width: 380px;
    margin-inline: auto;
  }
  @media (max-width: 640px) {
    .thead {
      padding: 8px 14px;
    }
    .tbody {
      padding: 14px;
    }
  }
</style>
