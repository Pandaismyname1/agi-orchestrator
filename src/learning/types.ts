/**
 * Shared contract for the self-improvement / learning loop (A3). Everything in
 * src/learning imports these. The learned "operator profile" tunes Qwen's
 * operator system prompt (see brain/decide.ts buildSystemPrompt). Storage reuses
 * the `preferences` table (no schema change) — see profileStore.ts for the keys.
 *
 * Safety posture: propose → approve → revert. Nothing here affects a live run
 * until the owner approves a profile; with no active profile the brain is
 * byte-identical to baseline.
 */

/** "global" or "cwd:<absolute cwd>". */
export type ProfileScope = string;
export const GLOBAL_SCOPE = "global";
export const cwdScope = (cwd: string): ProfileScope => `cwd:${cwd}`;

/** One mined/observed example of how the owner steered the agent. */
export interface ExampleBankItem {
  /** The agent's message the owner was responding to (truncated). */
  situation: string;
  /** What the owner actually told the agent to do next (truncated). */
  instruction: string;
  source: "past" | "live";
  /** Stable hash of (situation+instruction) for dedupe. */
  hash: string;
  count: number;
  lastSeen: number;
}

export interface ExampleBank {
  schema: 1;
  scope: ProfileScope;
  items: ExampleBankItem[];
  updatedAt: number;
}

/** A few-shot example carried inside an operator profile. */
export interface ProfileExample {
  situation: string;
  instruction: string;
}

/** The learned guidance injected into the operator system prompt. */
export interface OperatorProfile {
  schema: 1;
  scope: ProfileScope;
  version: number; // 1-based, monotonic per scope
  guidance: string; // prose bullets, clamped
  examples: ProfileExample[]; // <= maxFewShot
  createdAt: number;
  meta: {
    fromPastSessions: number;
    fromLiveCorrections: number;
    model: string;
    note?: string;
  };
}

/** Pointer to the live version for a scope. */
export interface ActiveProfileRef {
  scope: ProfileScope;
  version: number;
  activatedAt: number;
}

/** A pending, not-yet-approved profile for a scope. */
export interface DraftProposal {
  schema: 1;
  scope: ProfileScope;
  /** The proposed profile body (version/createdAt assigned on approval). */
  draft: Omit<OperatorProfile, "version" | "createdAt">;
  /** The active version this would supersede (for the diff), or null. */
  baseVersion: number | null;
  createdAt: number;
  /** Advisory replay-eval result (shown, NOT enforced yet). */
  eval?: EvalReport | null;
}

/** Advisory replay-eval: does the draft match the owner's past choices better? */
export interface EvalReport {
  schema: 1;
  total: number;
  baselineMatch: number; // Qwen WITHOUT the profile matched the owner
  profileMatch: number; // Qwen WITH the profile matched
  matchRate: number; // profileMatch / total
  delta: number; // profileMatch - baselineMatch (the signal)
  ranAt: number;
  note?: string;
}

/** Per-scope summary for the dashboard (GET /api/learning). */
export interface ProfileSummary {
  scope: ProfileScope;
  /** Human label: "global" or the cwd. */
  label: string;
  activeVersion: number | null;
  versions: number;
  examples: number;
  hasDraft: boolean;
  updatedAt: number | null;
}

export interface LearningSummary {
  enabled: boolean;
  global: ProfileSummary;
  projects: ProfileSummary[];
}

/**
 * Facade the supervisor + server depend on (implemented in service.ts). The
 * supervisor only ever calls `guidanceFor` on the hot path; the rest are
 * owner-triggered.
 */
export interface LearningService {
  readonly enabled: boolean;
  /** Hot path: merged (global ⊕ per-cwd) active guidance, clamped. "" if none. */
  guidanceFor(cwd: string): string;
  summary(): LearningSummary;
  /** Mine + derive + synthesize a DRAFT for a scope (default global). */
  synthesize(scope?: ProfileScope): Promise<DraftProposal>;
  /** Promote the draft to a new active version. */
  approve(scope?: ProfileScope): OperatorProfile;
  /** Discard the draft. */
  reject(scope?: ProfileScope): void;
  /** Repoint the active ref to an earlier version. */
  revert(scope: ProfileScope, version: number): void;
  getDraft(scope?: ProfileScope): DraftProposal | null;
  listVersions(scope?: ProfileScope): OperatorProfile[];
}
