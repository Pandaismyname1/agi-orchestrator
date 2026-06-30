/**
 * LearningService — the facade the supervisor + server use. Owns the propose →
 * approve → revert lifecycle and the only hot-path method (`guidanceFor`).
 * Composes the miner (past sessions) + live-correction derivation + synthesis +
 * advisory eval, all behind one object so the rest of the app stays decoupled.
 *
 * Safety: `guidanceFor` returns "" unless learning is enabled AND a profile has
 * been approved — so a live run is byte-identical to baseline until the owner
 * opts in and approves a draft.
 */
import type { Store } from "../db/store.js";
import { LocalLLM } from "../brain/provider.js";
import type { LearningOptions } from "../types.js";
import { ProfileStore } from "./profileStore.js";
import { mineExamples } from "./miner.js";
import { deriveRecentCorrections, deriveEscalationChoices } from "./liveSignals.js";
import { deriveRecentFeedback, deriveRecentFeedbackByCwd } from "./feedbackSignals.js";
import { synthesizeProfile } from "./synthesize.js";
import { replayEval } from "./eval.js";
import { truncate } from "./util.js";
import {
  GLOBAL_SCOPE,
  cwdScope,
  type DraftProposal,
  type ExampleBankItem,
  type LearningService as ILearningService,
  type LearningSummary,
  type OperatorProfile,
  type ProfileScope,
  type ProfileSummary,
} from "./types.js";

const DEFAULTS = {
  scanLimit: 60,
  maxExamples: 30,
  maxFewShot: 6,
  guidanceCharBudget: 700,
  evalHeldOut: 40,
};

function dedupe(items: ExampleBankItem[]): ExampleBankItem[] {
  const byHash = new Map<string, ExampleBankItem>();
  for (const it of items) {
    const e = byHash.get(it.hash);
    if (e) {
      e.count += it.count;
      e.lastSeen = Math.max(e.lastSeen, it.lastSeen);
    } else byHash.set(it.hash, { ...it });
  }
  return [...byHash.values()];
}

const scopeLabel = (scope: ProfileScope) =>
  scope === GLOBAL_SCOPE ? "Global" : scope.startsWith("cwd:") ? scope.slice(4) : scope;

export class LearningService implements ILearningService {
  private readonly profiles: ProfileStore;
  private readonly opts: Required<LearningOptions>;

  constructor(
    private readonly store: Store,
    private readonly llm: LocalLLM,
    options: LearningOptions | undefined,
    private readonly model: string,
  ) {
    this.profiles = new ProfileStore(store);
    this.opts = {
      enabled: options?.enabled ?? false,
      scanLimit: options?.scanLimit ?? DEFAULTS.scanLimit,
      maxExamples: options?.maxExamples ?? DEFAULTS.maxExamples,
      maxFewShot: options?.maxFewShot ?? DEFAULTS.maxFewShot,
      guidanceCharBudget: options?.guidanceCharBudget ?? DEFAULTS.guidanceCharBudget,
      evalHeldOut: options?.evalHeldOut ?? DEFAULTS.evalHeldOut,
    };
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private scopeOf(scope?: ProfileScope): ProfileScope {
    return scope && scope.length ? scope : GLOBAL_SCOPE;
  }

  // ---- hot path -----------------------------------------------------------

  /** Merged (global ⊕ per-cwd) active guidance for a run, clamped. "" if none. */
  guidanceFor(cwd: string): string {
    if (!this.opts.enabled) return "";
    const render = (p: OperatorProfile | null): string => {
      if (!p) return "";
      const ex = p.examples
        .slice(0, this.opts.maxFewShot)
        .map((e) => `- when the agent said: "${truncate(e.situation, 160)}" → I'd say: "${truncate(e.instruction, 160)}"`)
        .join("\n");
      return [p.guidance.trim(), ex && `Examples of how I steer:\n${ex}`].filter(Boolean).join("\n");
    };
    const parts: string[] = [];
    const g = render(this.profiles.getActive(GLOBAL_SCOPE));
    if (g) parts.push(g);
    const c = render(this.profiles.getActive(cwdScope(cwd)));
    if (c) parts.push(`For THIS project specifically:\n${c}`);
    if (parts.length === 0) return "";
    return truncate(parts.join("\n\n"), this.opts.guidanceCharBudget);
  }

  // ---- summary ------------------------------------------------------------

  private summaryFor(scope: ProfileScope): ProfileSummary {
    const ref = this.profiles.getActiveRef(scope);
    const bank = this.profiles.getExampleBank(scope);
    return {
      scope,
      label: scopeLabel(scope),
      activeVersion: ref?.version ?? null,
      versions: this.profiles.listVersions(scope).length,
      examples: bank.items.length,
      hasDraft: !!this.profiles.getDraft(scope),
      updatedAt: bank.items.length ? bank.updatedAt : (ref?.activatedAt ?? null),
    };
  }

  summary(): LearningSummary {
    return {
      enabled: this.opts.enabled,
      global: this.summaryFor(GLOBAL_SCOPE),
      projects: this.profiles.listProjectScopes().map((s) => this.summaryFor(s)),
    };
  }

  getDraft(scope?: ProfileScope): DraftProposal | null {
    return this.profiles.getDraft(this.scopeOf(scope));
  }

  listVersions(scope?: ProfileScope): OperatorProfile[] {
    return this.profiles.listVersions(this.scopeOf(scope)).sort((a, b) => b.version - a.version);
  }

  // ---- propose / approve / revert -----------------------------------------

  /** Mine + derive + synthesize a DRAFT for a scope (default global). */
  async synthesize(scope?: ProfileScope): Promise<DraftProposal> {
    const target = this.scopeOf(scope);

    // Refresh ALL banks from a single mining + derivation pass, so summaries are
    // populated and a global synthesize also seeds per-project banks.
    const mined = await mineExamples({ scanLimit: this.opts.scanLimit });
    const live = deriveRecentCorrections(this.store, 50);
    const escalations = deriveEscalationChoices(this.store, 50);
    // Explicit thumbs up/down on brain decisions — the strongest signal we have.
    const feedback = deriveRecentFeedback(this.store, 50);
    // The same thumbs grouped by project, so a 👍/👎 also tunes that project's
    // own profile — not just the global one (per-cwd thumbs scope).
    const feedbackByCwd = deriveRecentFeedbackByCwd(this.store, (id) => this.store.sessionCwd(id), 50);
    this.profiles.appendExamples(
      GLOBAL_SCOPE,
      dedupe([...mined.global, ...live, ...escalations, ...feedback]),
    );
    for (const [cwd, items] of mined.byCwd) {
      this.profiles.appendExamples(cwdScope(cwd), items);
    }
    // Merge per-project feedback into each project's bank (appendExamples dedupes
    // by hash, so this safely combines with mined examples for the same cwd).
    for (const [cwd, items] of feedbackByCwd) {
      this.profiles.appendExamples(cwdScope(cwd), items);
    }

    // Split the bank: positives feed the few-shot + held-out eval ("the owner
    // would say X"); negatives are anti-examples and must NEVER seed the eval
    // (they're "don't do X"), but they DO inform synthesis as an AVOID block.
    const bank = this.profiles.getExampleBank(target).items;
    const positives = bank.filter((i) => i.kind !== "negative");
    const negatives = bank.filter((i) => i.kind === "negative");
    const heldN = Math.min(this.opts.evalHeldOut, Math.floor(positives.length / 3));
    const synthPositives = heldN > 0 ? positives.slice(0, positives.length - heldN) : positives;
    const heldOut = heldN > 0 ? positives.slice(positives.length - heldN) : [];
    const synthInput = [...synthPositives, ...negatives];

    const pastCount = bank.filter((i) => i.source === "past").length;
    const liveCount = bank.filter((i) => i.source === "live").length;
    const activeVersion = this.profiles.getActiveRef(target)?.version ?? null;

    const draft = await synthesizeProfile(this.llm, synthInput, target, {
      model: this.model,
      maxExamples: this.opts.maxExamples,
      maxFewShot: this.opts.maxFewShot,
      guidanceCharBudget: 1600,
      baseVersion: activeVersion,
      pastCount,
      liveCount,
    });

    // Advisory eval (shown, not enforced).
    try {
      draft.eval = await replayEval(this.llm, heldOut, draft.draft.guidance, {});
    } catch {
      draft.eval = null;
    }

    this.profiles.saveDraft(draft);
    return draft;
  }

  approve(scope?: ProfileScope): OperatorProfile {
    const target = this.scopeOf(scope);
    const draft = this.profiles.getDraft(target);
    if (!draft) throw new Error(`no pending draft for ${scopeLabel(target)}`);
    const profile = this.profiles.saveVersionAndActivate(draft.draft);
    this.profiles.clearDraft(target);
    return profile;
  }

  reject(scope?: ProfileScope): void {
    this.profiles.clearDraft(this.scopeOf(scope));
  }

  revert(scope: ProfileScope, version: number): void {
    this.profiles.activateVersion(this.scopeOf(scope), version);
  }
}

/** A disabled, empty summary for when no store/service is available. */
export function emptyLearningSummary(): LearningSummary {
  const empty: ProfileSummary = {
    scope: GLOBAL_SCOPE,
    label: "Global",
    activeVersion: null,
    versions: 0,
    examples: 0,
    hasDraft: false,
    updatedAt: null,
  };
  return { enabled: false, global: empty, projects: [] };
}
