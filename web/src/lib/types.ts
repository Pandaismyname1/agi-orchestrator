/**
 * Frontend mirror of the backend DTOs (src/server/supervisor.ts + server/index.ts).
 * Kept deliberately small and structural — only what the dashboard renders.
 */

export type SessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "manual"
  | "needs-input"
  | "rate-limited"
  | "stopped"
  | "blocked"
  | "done"
  | "error";

export type SessionMode = "manual" | "autopilot";

export type PermissionMode = "default" | "acceptEdits" | "auto" | "bypassPermissions";

export type Autonomy = "cautious" | "balanced" | "autonomous";

export interface AttentionOption {
  label: string;
  rationale?: string;
}

export interface AttentionRequest {
  /** "gate" = risky-action approval; otherwise a brain-raised human decision. */
  kind?: string;
  question: string;
  options?: AttentionOption[];
}

export interface SessionView {
  id: string;
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode: PermissionMode;
  autonomy?: Autonomy;
  mode: SessionMode;
  status: SessionStatus;
  turns: number;
  elapsedMin: number;
  lastReply: string;
  lastDecision: string;
  error?: string;
  attention?: AttentionRequest | null;
  /** True when the session has run before and can be continued (resumed). */
  canContinue?: boolean;
  /** ids of sessions this one runs after (auto-starts once they're all `done`). */
  dependsOn?: string[];
  /** subset of `dependsOn` not yet `done` (live-computed; non-empty only while waiting). */
  blockedBy?: string[];
}

/** Continue a finished session: edited goal / next instruction / mode to resume with. */
export type ContinuePatch = Partial<{
  goal: string;
  doneCriteria: string;
  instruction: string;
  startMode: SessionMode;
}>;

export interface Provider {
  model: string;
  baseUrl: string;
  ok: boolean;
}

export interface Budget {
  turns: number;
  maxTurns?: number;
  minutes: number;
  maxMinutes?: number;
  exceeded: boolean;
}

/** One of Claude's real subscription limits (from /usage). */
export interface LimitWindow {
  pct: number;
  resetText?: string;
  resetAt?: number;
}
export interface UsageStatus {
  session?: LimitWindow;
  weeklyAll?: LimitWindow;
  weeklySonnet?: LimitWindow;
  capturedAt: number;
}

export interface FocusView {
  id: string;
  screen: string;
}

/** Runtime-editable global settings, echoed in the snapshot (backend cfg → here). */
export interface Settings {
  providerModel: string;
  providerBaseUrl: string;
  maxConcurrent: number;
  budget: { maxTurns: number | null; maxMinutes: number | null };
  defaults: { permissionMode: PermissionMode; autonomy: Autonomy };
}

export type SettingsPatch = Partial<{
  providerModel: string;
  maxConcurrent: number;
  budgetMaxTurns: number | null;
  budgetMaxMinutes: number | null;
  defaultPermissionMode: PermissionMode;
  defaultAutonomy: Autonomy;
}>;

/** Learning loop: synthesized operator profiles that tune the local brain's prompt. */
export interface ProfileExample {
  situation: string;
  instruction: string;
}

export interface OperatorProfile {
  schema: 1;
  scope: string;
  version: number;
  guidance: string;
  examples: ProfileExample[];
  createdAt: number;
  meta: {
    fromPastSessions: number;
    fromLiveCorrections: number;
    model: string;
    note?: string;
  };
}

export interface EvalReport {
  schema: 1;
  total: number;
  baselineMatch: number;
  profileMatch: number;
  matchRate: number;
  delta: number;
  ranAt: number;
  note?: string;
}

export interface DraftProposal {
  schema: 1;
  scope: string;
  draft: Omit<OperatorProfile, "version" | "createdAt">;
  baseVersion: number | null;
  createdAt: number;
  eval?: EvalReport | null;
}

export interface ProfileSummary {
  scope: string;
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

export interface Snapshot {
  type: "snapshot";
  provider: Provider;
  budget?: Budget | null;
  usage?: UsageStatus | null;
  sessions: SessionView[];
  focus?: FocusView;
  settings?: Settings;
  learning?: LearningSummary;
}

/** Payload to register a hand-started session for hook-attach driving (POST /attach). */
export interface AttachInput {
  session_id: string;
  goal: string;
  doneCriteria: string;
}

/** Payload to create a session (subset of SessionConfig). */
export interface SessionInput {
  id?: string;
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode?: PermissionMode;
  autonomy?: Autonomy;
  startMode?: SessionMode;
  resumeId?: string;
  /** ids of sessions this one runs after (waits until they're all `done`). */
  dependsOn?: string[];
}

export type SessionPatch = Partial<{
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode: PermissionMode;
  autonomy: Autonomy;
  startMode: SessionMode;
  dependsOn: string[];
}>;

/** How the user answered an open human-decision. */
export interface ResolveChoice {
  optionIndex?: number;
  customPrompt?: string;
  stop?: boolean;
}

/** Outbound WebSocket messages (must match server/index.ts ClientMsg). */
export type ClientMsg =
  | { type: "start"; id: string }
  | { type: "stop"; id: string }
  | { type: "startAll" }
  | { type: "stopAll" }
  | { type: "focus"; id: string }
  | { type: "add"; session: SessionInput }
  | { type: "update"; id: string; patch: SessionPatch }
  | { type: "remove"; id: string }
  | { type: "resolve"; id: string; choice: ResolveChoice }
  | { type: "setMode"; id: string; mode: SessionMode }
  | { type: "sendMessage"; id: string; text: string }
  | { type: "updateSettings"; settings: SettingsPatch }
  | { type: "continue"; id: string; continue: ContinuePatch }
  | { type: "learnSynthesize"; scope?: string }
  | { type: "learnApprove"; scope?: string }
  | { type: "learnReject"; scope?: string }
  | { type: "learnRevert"; scope: string; version: number };

/** Discovered on-disk Claude Code session (GET /api/discover). */
export interface DiscoveredSession {
  sessionId: string;
  cwd: string;
  summary: string;
  turns: number;
  lastActivity: number;
  /** "cli" (terminal) or "desktop" (Claude Desktop's agent mode). */
  source?: "cli" | "desktop";
  /** Desktop sessions carry a human title. */
  title?: string;
  /** Real project root (Desktop runs in a worktree under it). */
  projectCwd?: string;
  /** False when the transcript is gone (archived/worktree removed) — can't resume. */
  resumable?: boolean;
}

/** History/metrics rows (GET /api/runs, /api/run, /api/metrics). */
export interface RunRow {
  id: number;
  status: string;
  turns: number;
  elapsed_min: number | null;
  stop_reason: string | null;
}

export interface Metrics {
  runs: number;
  turns: number;
  avgTurns: number;
  interventionRate: number;
  byStatus: Record<string, number>;
}

export interface TurnRow {
  n: number;
  injected_prompt: string | null;
  assistant_text: string | null;
}

export interface DecisionRow {
  n: number;
  action: "continue" | "stop" | "escalate";
  prompt?: string | null;
  reason?: string | null;
}

export interface RunDetail {
  run: RunRow | null;
  turns: TurnRow[];
  decisions: DecisionRow[];
  events: { type: string }[];
}
