<script lang="ts">
  import type {
    LearningSummary,
    ProfileSummary,
    DraftProposal,
    OperatorProfile,
  } from "../../lib/types";
  import { api } from "../../lib/api";
  import { wsStore } from "../../lib/ws.svelte";
  import { ui } from "../../lib/ui.svelte";
  import { ago } from "../../lib/format";
  import Modal from "../Modal.svelte";
  import Icon from "../Icon.svelte";

  // null = loading, then either the summary or a failure-driven empty shell.
  let summary = $state<LearningSummary | null>(null);
  let loadFailed = $state(false);

  let selectedScope = $state<string>("global");

  // Per-scope draft + versions (re-fetched whenever the scope changes).
  let draft = $state<DraftProposal | null>(null);
  let versions = $state<OperatorProfile[]>([]);
  let detailLoading = $state(true);
  let busy = $state(false);

  let scopes = $derived<ProfileSummary[]>(
    summary ? [summary.global, ...summary.projects] : [],
  );
  let selected = $derived(scopes.find((s) => s.scope === selectedScope) ?? scopes[0] ?? null);

  // Newest active version's guidance, for the diff's "active" column.
  let activeGuidance = $derived(versions.length ? versions[0].guidance : "");

  async function loadSummary() {
    try {
      summary = await api.learning();
    } catch {
      loadFailed = true;
      summary = null;
      ui.toast("couldn't load learning state");
    }
  }

  async function loadDetail(scope: string) {
    detailLoading = true;
    try {
      const [d, v] = await Promise.all([api.learningDraft(scope), api.learningVersions(scope)]);
      // Guard against a race if the scope changed mid-fetch.
      if (selectedScope !== scope) return;
      draft = d;
      versions = v;
    } catch {
      if (selectedScope !== scope) return;
      draft = null;
      versions = [];
      ui.toast("couldn't load profile detail");
    } finally {
      if (selectedScope === scope) detailLoading = false;
    }
  }

  function pick(scope: string) {
    if (scope === selectedScope) return;
    selectedScope = scope;
    draft = null;
    versions = [];
    void loadDetail(scope);
  }

  async function refresh() {
    await loadSummary();
    await loadDetail(selectedScope);
  }

  function synthesize() {
    if (busy) return;
    busy = true;
    wsStore.send({ type: "learnSynthesize", scope: selectedScope });
    ui.toast("synthesizing… (this runs the local model)");
    // The synth runs on the backend; give it a moment, then re-pull.
    setTimeout(() => {
      void refresh().finally(() => (busy = false));
    }, 2500);
  }

  function approve() {
    wsStore.send({ type: "learnApprove", scope: selectedScope });
    ui.toast("draft approved — it's now the active profile");
    setTimeout(() => void refresh(), 400);
  }

  function reject() {
    wsStore.send({ type: "learnReject", scope: selectedScope });
    ui.toast("draft rejected");
    setTimeout(() => void refresh(), 400);
  }

  function revert(version: number) {
    wsStore.send({ type: "learnRevert", scope: selectedScope, version });
    ui.toast(`reverting to v${version}`);
    setTimeout(() => void refresh(), 400);
  }

  // Kick off the initial load, then pull detail for the default scope.
  void loadSummary().then(() => loadDetail(selectedScope));
</script>

<Modal title="Learn — operator profiles" width={620} onclose={() => ui.closeModal()}>
  {#if summary === null && !loadFailed}
    <div class="lm-empty">loading…</div>
  {:else if loadFailed}
    <div class="lm-note">
      <Icon name="alert" size={13} />
      Learning state unavailable — is the backend reachable?
    </div>
    <div class="lm-foot">
      <button class="btn btn-sm" onclick={() => ui.closeModal()}>Close</button>
    </div>
  {:else if summary}
    {#if !summary.enabled}
      <div class="lm-note">
        <Icon name="info" size={13} />
        The learning loop is disabled. Enable it in the backend to synthesize profiles.
      </div>
    {/if}

    <!-- Scope selector -->
    <div class="lm-scopes">
      {#each scopes as s (s.scope)}
        <button
          class="lm-scope"
          class:on={s.scope === selectedScope}
          onclick={() => pick(s.scope)}
        >
          <span class="lm-scope-label">{s.label}</span>
          {#if s.hasDraft}<span class="lm-draftdot" title="Draft waiting"></span>{/if}
          <span class="lm-scope-meta">
            {s.activeVersion !== null ? `v${s.activeVersion}` : "none"} · {s.examples} ex
          </span>
        </button>
      {/each}
    </div>

    {#if summary.feedback.up + summary.feedback.down > 0}
      {@const total = summary.feedback.up + summary.feedback.down}
      <div
        class="lm-thumbs"
        title="Your 👍/👎 on brain decisions are folded into synthesis — up-rated as strong positive examples, down-rated into an AVOID block."
      >
        <Icon name="thumbsUp" size={12} />
        <span>Learning from your <b>{total}</b> thumb{total === 1 ? "" : "s"}</span>
        <span class="lm-thumbs-detail">👍 {summary.feedback.up} · 👎 {summary.feedback.down}</span>
      </div>
    {/if}

    {#if selected}
      <div class="lm-selhead">
        <div class="lm-stat"><b>{selected.versions}</b> versions</div>
        <div class="lm-stat"><b>{selected.examples}</b> examples</div>
        <div class="lm-stat">
          updated {selected.updatedAt ? ago(selected.updatedAt) : "never"}
        </div>
        <button class="btn btn-sm btn-primary lm-synth" disabled={busy} onclick={synthesize}>
          <Icon name="spark" size={13} />
          {busy ? "synthesizing…" : "Synthesize draft"}
        </button>
      </div>

      {#if detailLoading}
        <div class="lm-empty">loading profile…</div>
      {:else}
        <!-- Pending draft -->
        {#if draft}
          <div class="lm-section">
            <div class="lm-head"><Icon name="spark" size={12} /> Proposed change</div>
            <div class="lm-diff">
              <div class="lm-col">
                <div class="lm-col-label">active{activeGuidance ? "" : " (none yet)"}</div>
                <div class="lm-guidance old">{activeGuidance || "No active profile yet."}</div>
              </div>
              <div class="lm-col">
                <div class="lm-col-label proposed">proposed</div>
                <div class="lm-guidance new">{draft.draft.guidance}</div>
              </div>
            </div>

            {#if draft.draft.examples.length}
              <div class="lm-ex-label">few-shot examples ({draft.draft.examples.length})</div>
              <div class="lm-examples">
                {#each draft.draft.examples as ex, i (i)}
                  <div class="lm-ex">
                    <div class="lm-ex-sit">{ex.situation}</div>
                    <div class="lm-ex-ins">→ {ex.instruction}</div>
                  </div>
                {/each}
              </div>
            {/if}

            {#if draft.eval}
              <div class="lm-eval" title="Advisory only — not a gate">
                advisory eval: +{draft.eval.delta} matches (Δ {draft.eval.delta} of {draft.eval
                  .total}) — not a gate yet
              </div>
            {/if}

            {#if draft.draft.meta.note}
              <div class="lm-metanote">{draft.draft.meta.note}</div>
            {/if}

            <div class="lm-actions">
              <button class="btn btn-sm" onclick={reject}>Reject</button>
              <button class="btn btn-sm btn-primary" onclick={approve}>Approve</button>
            </div>
          </div>
        {:else if versions.length === 0}
          <div class="lm-section">
            <div class="lm-empty">
              No profile yet — run a few sessions, then Synthesize.
            </div>
          </div>
        {/if}

        <!-- Version history -->
        {#if versions.length}
          <div class="lm-section">
            <div class="lm-head">Version history</div>
            {#each versions as v (v.version)}
              <div class="lm-vrow">
                <span class="lm-vbadge" class:active={v.version === selected.activeVersion}>
                  v{v.version}
                </span>
                <span class="lm-vmeta">{ago(v.createdAt)} · {v.examples.length} ex</span>
                <span class="lm-vfrom">
                  {v.meta.fromPastSessions} past · {v.meta.fromLiveCorrections} live
                </span>
                <button
                  class="btn btn-xs lm-revert"
                  disabled={v.version === selected.activeVersion}
                  onclick={() => revert(v.version)}
                >
                  Revert
                </button>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}

    <div class="lm-foot">
      <button class="btn btn-sm" onclick={() => ui.closeModal()}>Close</button>
    </div>
  {/if}
</Modal>

<style>
  .lm-empty {
    color: var(--faint);
    padding: 24px;
    text-align: center;
  }
  .lm-note {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--color-warning);
    background: rgba(251, 191, 36, 0.08);
    border: 1px solid rgba(251, 191, 36, 0.25);
    border-radius: 9px;
    padding: 8px 10px;
    margin-bottom: 14px;
  }

  .lm-scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
  }
  .lm-scope {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    padding: 8px 12px;
    cursor: pointer;
    color: var(--color-base-content);
    font: inherit;
    min-width: 96px;
  }
  .lm-scope:hover {
    border-color: var(--color-primary);
  }
  .lm-scope.on {
    border-color: var(--color-primary);
    background: rgba(34, 197, 94, 0.08);
  }
  .lm-scope-label {
    font-size: 13px;
    font-weight: 600;
  }
  .lm-scope-meta {
    font-size: 11px;
    color: var(--color-neutral-content);
  }
  .lm-draftdot {
    position: absolute;
    top: 7px;
    right: 9px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-warning);
  }

  .lm-thumbs {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--color-neutral-content);
    background: var(--color-base-200);
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    padding: 7px 11px;
    margin-bottom: 14px;
  }
  .lm-thumbs b {
    color: var(--color-base-content);
    font-weight: 700;
  }
  .lm-thumbs-detail {
    margin-left: auto;
    color: var(--faint);
    font-size: 11px;
  }

  .lm-selhead {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  .lm-stat {
    font-size: 12px;
    color: var(--color-neutral-content);
  }
  .lm-stat b {
    color: var(--color-base-content);
    font-weight: 700;
  }
  .lm-synth {
    margin-left: auto;
  }

  .lm-section {
    padding: 14px 0;
    border-bottom: 1px solid var(--border-soft);
  }
  .lm-section:last-of-type {
    border-bottom: none;
  }
  .lm-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    font-weight: 700;
    color: var(--faint);
    margin-bottom: 10px;
  }

  .lm-diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .lm-col-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-neutral-content);
    margin-bottom: 4px;
    font-weight: 600;
  }
  .lm-col-label.proposed {
    color: var(--color-primary);
  }
  .lm-guidance {
    font-size: 12.5px;
    line-height: 1.45;
    border-radius: 9px;
    padding: 9px 11px;
    border: 1px solid var(--border-soft);
    background: var(--color-base-200);
    white-space: pre-wrap;
  }
  .lm-guidance.old {
    color: var(--color-neutral-content);
  }
  .lm-guidance.new {
    color: var(--color-base-content);
    border-color: rgba(34, 197, 94, 0.4);
    background: rgba(34, 197, 94, 0.06);
  }

  .lm-ex-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-neutral-content);
    margin: 14px 0 6px;
    font-weight: 600;
  }
  .lm-examples {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .lm-ex {
    border-left: 2px solid var(--border-strong);
    padding: 4px 0 4px 11px;
  }
  .lm-ex-sit {
    font-size: 12.5px;
    color: var(--color-base-content);
  }
  .lm-ex-ins {
    font-size: 12.5px;
    color: var(--color-secondary);
    margin-top: 2px;
  }

  .lm-eval {
    font-size: 12px;
    color: var(--color-neutral-content);
    margin-top: 12px;
    font-style: italic;
  }
  .lm-metanote {
    font-size: 12px;
    color: var(--faint);
    margin-top: 6px;
  }

  .lm-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 14px;
  }

  .lm-vrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
  }
  .lm-vrow + .lm-vrow {
    border-top: 1px solid var(--border-soft);
  }
  .lm-vbadge {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 20px;
    border: 1px solid var(--border-soft);
    color: var(--color-neutral-content);
  }
  .lm-vbadge.active {
    color: var(--color-primary);
    border-color: rgba(34, 197, 94, 0.5);
  }
  .lm-vmeta {
    font-size: 12px;
    color: var(--color-neutral-content);
  }
  .lm-vfrom {
    margin-left: auto;
    font-size: 11px;
    color: var(--faint);
  }
  .lm-revert {
    flex: none;
  }

  .lm-foot {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }

  @media (max-width: 560px) {
    .lm-diff {
      grid-template-columns: 1fr;
    }
  }
</style>
