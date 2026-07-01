<script lang="ts">
  import type { SessionView } from "../lib/types";
  import { wsStore } from "../lib/ws.svelte";
  import { ui } from "../lib/ui.svelte";
  import { minutes } from "../lib/format";
  import Icon from "./Icon.svelte";
  import StatusBadge from "./StatusBadge.svelte";

  interface Props {
    session: SessionView;
    selected: boolean;
    /** Multi-select mode: clicking the card toggles its checkbox instead of focusing. */
    selectMode?: boolean;
    /** Whether this card is checked for a bulk action. */
    checked?: boolean;
    /** Toggle this card's bulk-selection. */
    onToggleSelect?: () => void;
  }
  let { session: s, selected, selectMode = false, checked = false, onToggleSelect }: Props = $props();

  let isActive = $derived(["running", "manual", "needs-input", "paused"].includes(s.status));

  /** Resolve a dependency id to a short, human label (its goal, else the id). */
  function depLabel(id: string): string {
    const dep = wsStore.snapshot?.sessions.find((x) => x.id === id);
    const goal = dep?.goal?.trim();
    return goal ? (goal.length > 40 ? goal.slice(0, 40) + "…" : goal) : id;
  }
  let blockers = $derived(s.blockedBy ?? []);
  let waiting = $derived(s.status === "blocked" || blockers.length > 0);
  let deps = $derived(s.dependsOn ?? []);

  // Compact "auto-start schedule" label, e.g. "every 60m · 02:00".
  let schedLabel = $derived.by(() => {
    const sc = s.schedule;
    if (!sc) return "";
    const parts: string[] = [];
    if (sc.everyMinutes) parts.push(`every ${sc.everyMinutes}m`);
    if (sc.dailyAt) parts.push(sc.dailyAt);
    const t = parts.join(" · ");
    if (!t) return "";
    return sc.enabled === false ? `${t} (paused)` : t;
  });

  // Per-session notification override chip: "muted", or "alerts: error" allow-list.
  let notifyChip = $derived.by(() => {
    const n = s.notify;
    if (!n) return "";
    if (n.mute) return "muted";
    if (n.events && n.events.length) return `alerts: ${n.events.join(", ")}`;
    return "";
  });

  // Thumbs tally across this session's brain decisions (shown when it has any).
  let fb = $derived(s.feedback);
  let hasFeedback = $derived(!!fb && fb.up + fb.down > 0);

  // Auto-PR chip: link to the opened PR (with #number when parseable), else its lifecycle state.
  let prNumber = $derived.by(() => {
    const m = s.prUrl?.match(/\/pull\/(\d+)/);
    return m ? `#${m[1]}` : "";
  });

  function focus() {
    if (selectMode) {
      onToggleSelect?.();
      return;
    }
    ui.focusId = s.id;
    wsStore.send({ type: "focus", id: s.id });
  }
  function del(e: MouseEvent) {
    e.stopPropagation();
    if (confirm(`Delete session "${s.id}"? This removes it from config.json.`)) {
      wsStore.send({ type: "remove", id: s.id });
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="agent {s.status}" class:sel={selected} class:picked={selectMode && checked} data-fleet-id={s.id} onclick={focus}>
  <div class="top">
    {#if selectMode}
      <input
        type="checkbox"
        class="pick"
        {checked}
        onclick={(e) => {
          e.stopPropagation();
          onToggleSelect?.();
        }}
        aria-label="Select {s.id} for bulk action"
      />
    {/if}
    <span class="name" title={s.id}>{s.id}</span>
    <span class="mode-chip {s.mode}" title="{s.mode} mode">
      <Icon name={s.mode === "manual" ? "hand" : "bot"} size={11} />
      {s.mode}
    </span>
  </div>

  <p class="goal" title={s.goal}>{s.goal}</p>

  <div class="statusrow">
    <StatusBadge status={s.status} />
    <span class="metric tnum" title="turns · elapsed">turn {s.turns} · {minutes(s.elapsedMin)}</span>
  </div>

  {#if schedLabel || notifyChip || hasFeedback || s.prUrl}
    <div class="chips">
      {#if schedLabel}
        <span class="chip" class:paused={s.schedule?.enabled === false} title="Auto-start schedule">
          <Icon name="clock" size={11} /> {schedLabel}
        </span>
      {/if}
      {#if notifyChip}
        <span class="chip" class:muted={s.notify?.mute} title="Per-session notification override">
          <Icon name={s.notify?.mute ? "bellOff" : "bell"} size={11} /> {notifyChip}
        </span>
      {/if}
      {#if s.prUrl}
        <a
          class="chip pr {s.prState ?? 'open'}"
          href={s.prUrl}
          target="_blank"
          rel="noreferrer"
          title="Open the auto-created pull request"
          onclick={(e) => e.stopPropagation()}
        >
          <Icon name="external" size={11} /> PR{prNumber ? ` ${prNumber}` : ""}
        </a>
      {/if}
      {#if hasFeedback && fb}
        <span class="chip fb" title="Operator thumbs on this session's decisions">
          <Icon name="thumbsUp" size={10} /> {fb.up}
          <Icon name="thumbsDown" size={10} /> {fb.down}
        </span>
      {/if}
    </div>
  {/if}

  {#if s.reviewRequired}
    <div class="banner review" title="This step is deeper than the workflow depth cap — start it yourself to continue.">
      <Icon name="pip" size={12} /> Needs review — start manually to continue
    </div>
  {:else if waiting && blockers.length}
    <div class="banner waiting">
      <Icon name="clock" size={12} /> Waiting on {blockers.map(depLabel).join(", ")}
    </div>
  {/if}

  {#if deps.length}
    <div class="deps">
      <span class="runs-after">Runs after</span>
      {#each deps as d (d)}
        <span class="dep-chip" title={depLabel(d)}>{depLabel(d)}</span>
      {/each}
    </div>
  {/if}

  {#if s.lastDecision}
    <div class="dec" title={s.lastDecision}>
      <Icon name="brain" size={12} class="dec-ic" />
      <span class="dec-txt">{s.lastDecision}</span>
    </div>
  {/if}

  {#if !selectMode}
    <div class="acts">
      {#if isActive}
        <button
          class="btn btn-xs"
          onclick={(e) => {
            e.stopPropagation();
            wsStore.send({ type: "stop", id: s.id });
          }}
        >
          <Icon name="stop" size={12} /> Stop
        </button>
      {:else if s.canContinue}
        <button
          class="btn btn-xs btn-primary"
          title="Resume this conversation with a new instruction"
          onclick={(e) => {
            e.stopPropagation();
            ui.openModal({ kind: "continue", session: s });
          }}
        >
          <Icon name="play" size={12} /> Continue
        </button>
        <button
          class="btn btn-xs"
          title="Start fresh (new conversation)"
          onclick={(e) => {
            e.stopPropagation();
            wsStore.send({ type: "start", id: s.id });
          }}
        >
          Start
        </button>
        <span class="acts-sp"></span>
        <button
          class="btn btn-xs btn-square"
          title="Edit"
          onclick={(e) => {
            e.stopPropagation();
            ui.openModal({ kind: "edit", session: s });
          }}
        >
          <Icon name="edit" size={12} />
        </button>
        <button
          class="btn btn-xs btn-square del"
          title="Delete"
          onclick={(e) => {
            e.stopPropagation();
            del(e);
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      {:else}
        <button
          class="btn btn-xs btn-primary"
          onclick={(e) => {
            e.stopPropagation();
            wsStore.send({ type: "start", id: s.id });
          }}
        >
          <Icon name="play" size={12} /> Start
        </button>
        <span class="acts-sp"></span>
        <button
          class="btn btn-xs btn-square"
          title="Edit"
          onclick={(e) => {
            e.stopPropagation();
            ui.openModal({ kind: "edit", session: s });
          }}
        >
          <Icon name="edit" size={12} />
        </button>
        <button class="btn btn-xs btn-square del" title="Delete" onclick={del}>
          <Icon name="trash" size={12} />
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .agent {
    position: relative;
    /* In the fleet's scrolling flex-column, a plain flex item resolves its
       flex-basis against the container and gets stretched to fill; pin the
       height to its content so each card sizes to what it actually shows. */
    flex: none;
    height: max-content;
    padding: 12px 13px 12px 15px;
    background: linear-gradient(180deg, var(--color-base-200), var(--color-base-100));
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-box);
    cursor: pointer;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 9px;
    transition:
      border-color 0.15s,
      transform 0.1s,
      box-shadow 0.15s;
  }
  .agent::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--st-idle);
    opacity: 0.85;
  }
  .agent:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    border-color: var(--border-strong);
  }
  .agent.sel {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.35);
  }
  .agent.picked {
    border-color: var(--color-primary);
    background: rgba(34, 197, 94, 0.07);
  }
  .pick {
    width: 15px;
    height: 15px;
    flex: none;
    margin: 0;
    accent-color: var(--color-primary);
    cursor: pointer;
  }
  .agent.running::before {
    background: var(--st-running);
    box-shadow: 0 0 10px var(--st-running);
  }
  .agent.manual::before {
    background: var(--st-manual);
  }
  .agent.done::before {
    background: var(--st-done);
  }
  .agent.stopped::before,
  .agent.rate-limited::before,
  .agent.paused::before {
    background: var(--st-stopped);
  }
  .agent.error::before {
    background: var(--st-error);
  }
  .agent.queued::before {
    background: var(--st-queued);
    opacity: 0.5;
  }
  .agent.blocked::before {
    background: var(--st-stopped);
    opacity: 0.7;
  }
  .agent.needs-input::before {
    background: var(--st-needs-input);
  }
  .agent.needs-input {
    border-color: var(--st-needs-input);
    animation: cardpulse 1.4s ease-in-out infinite;
  }
  @keyframes cardpulse {
    0%,
    100% {
      box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.25);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(251, 191, 36, 0.6),
        0 0 18px rgba(251, 191, 36, 0.18);
    }
  }
  /* An error means work has STOPPED and needs you — flash it red, urgently. */
  .agent.error {
    border-color: var(--st-error);
    animation: cardpulse-red 1.15s ease-in-out infinite;
  }
  @keyframes cardpulse-red {
    0%,
    100% {
      box-shadow: 0 0 0 1px rgba(248, 113, 113, 0.3);
    }
    50% {
      box-shadow:
        0 0 0 1px rgba(248, 113, 113, 0.75),
        0 0 20px rgba(248, 113, 113, 0.22);
    }
  }

  /* --- header: name + mode --- */
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .name {
    font-weight: 650;
    font-size: 13.5px;
    letter-spacing: -0.1px;
    color: var(--color-base-content);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mode-chip {
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 500;
    color: var(--color-neutral-content);
    padding: 2px 7px;
    border: 1px solid var(--border-soft);
    border-radius: 20px;
    background: var(--color-base-100);
  }
  .mode-chip.manual {
    color: var(--st-manual);
    border-color: rgba(96, 165, 250, 0.4);
  }
  .mode-chip.autopilot {
    color: var(--st-running);
    border-color: rgba(34, 197, 94, 0.4);
  }

  .goal {
    color: var(--color-neutral-content);
    font-size: 12px;
    margin: 0;
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* --- status + metric --- */
  .statusrow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .metric {
    margin-left: auto;
    flex: none;
    font-size: 11px;
    color: var(--faint);
  }

  /* --- secondary chips (schedule / notify / PR / feedback) --- */
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    color: var(--color-neutral-content);
    padding: 2px 7px;
    border: 1px solid var(--border-soft);
    border-radius: 20px;
    background: var(--color-base-100);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.paused {
    opacity: 0.55;
  }
  .chip.muted {
    color: var(--st-stopped);
    border-color: rgba(251, 191, 36, 0.4);
    opacity: 0.9;
  }
  .chip.fb {
    gap: 3px;
    color: var(--faint);
  }
  a.chip.pr {
    text-decoration: none;
    color: var(--st-done);
    border-color: rgba(96, 165, 250, 0.4);
    background: rgba(96, 165, 250, 0.08);
    transition: border-color 0.15s, background 0.15s;
  }
  a.chip.pr:hover {
    border-color: var(--st-done);
    background: rgba(96, 165, 250, 0.16);
  }
  a.chip.pr.failed {
    color: var(--st-error);
    border-color: rgba(248, 113, 113, 0.4);
    background: rgba(248, 113, 113, 0.08);
  }
  a.chip.pr.opening {
    color: var(--st-stopped);
    border-color: rgba(251, 191, 36, 0.4);
    background: rgba(251, 191, 36, 0.06);
  }

  /* --- attention banners --- */
  .banner {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    line-height: 1.35;
    padding: 6px 8px;
    border-radius: 8px;
  }
  .banner :global(svg) {
    flex: none;
  }
  .banner.review {
    font-weight: 600;
    color: var(--st-needs-input);
    background: rgba(251, 191, 36, 0.08);
    border: 1px solid rgba(251, 191, 36, 0.3);
  }
  .banner.waiting {
    color: var(--st-stopped);
    background: rgba(251, 191, 36, 0.05);
    border: 1px solid rgba(251, 191, 36, 0.22);
  }

  /* --- dependencies --- */
  .deps {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--faint);
  }
  .runs-after {
    color: var(--faint);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-size: 9.5px;
    font-weight: 600;
  }
  .dep-chip {
    font-size: 10px;
    color: var(--color-neutral-content);
    padding: 1px 7px;
    border: 1px solid var(--border-soft);
    border-radius: 20px;
    background: var(--color-base-100);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* --- brain decision --- */
  .dec {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 11px;
    color: var(--color-neutral-content);
    padding-top: 9px;
    border-top: 1px dashed var(--border-soft);
  }
  .dec :global(.dec-ic) {
    flex: none;
    margin-top: 1px;
    color: var(--color-primary);
  }
  .dec-txt {
    min-width: 0;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* --- actions --- */
  .acts {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 1px;
  }
  .acts-sp {
    margin-left: auto;
  }
  .del:hover {
    border-color: var(--color-error);
    color: var(--color-error);
  }
</style>
