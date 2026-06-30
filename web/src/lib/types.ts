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
  | "paused"
  | "stopped"
  | "blocked"
  | "done"
  | "error";

export type SessionMode = "manual" | "autopilot";

export type PermissionMode = "default" | "acceptEdits" | "auto" | "bypassPermissions";

export type Autonomy = "cautious" | "balanced" | "autonomous";

/** Auto-start schedule: every N minutes and/or daily at a local HH:MM. */
export interface SessionSchedule {
  enabled?: boolean;
  everyMinutes?: number;
  dailyAt?: string;
}

/** Auto-open a PR when a session hits its done-criteria (opt-in). */
export interface AutoPrConfig {
  mode: "draft" | "ready";
  /** Base branch (default: origin's default branch). */
  base?: string;
}

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
  /** Operator thumbs on the current/last brain decision ('up'|'down'), if rated. */
  lastDecisionFeedback?: "up" | "down";
  /** Aggregated thumbs tally across this session's decisions. */
  feedback?: { up: number; down: number };
  error?: string;
  attention?: AttentionRequest | null;
  /** True when the session has run before and can be continued (resumed). */
  canContinue?: boolean;
  /** ids of sessions this one runs after (auto-starts once they're all `done`). */
  dependsOn?: string[];
  /** subset of `dependsOn` not yet `done` (live-computed; non-empty only while waiting). */
  blockedBy?: string[];
  /** auto-start schedule (every N minutes / daily HH:MM), if configured. */
  schedule?: SessionSchedule;
  /** auto-open-a-PR-on-done setting, if configured. */
  autoPr?: AutoPrConfig;
  /** URL of the PR opened for the last completed run, if any. */
  prUrl?: string;
  /** lifecycle of the auto-PR for the current/last run. */
  prState?: "opening" | "open" | "failed" | "skipped";
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
  /** Self-healing tuning: brain-call retries + auto-pause health-poll cadence. */
  reliability?: { retries: number; retryBackoffMs: number; brainPollSeconds: number };
}

export type SettingsPatch = Partial<{
  providerModel: string;
  maxConcurrent: number;
  budgetMaxTurns: number | null;
  budgetMaxMinutes: number | null;
  defaultPermissionMode: PermissionMode;
  defaultAutonomy: Autonomy;
  reliabilityRetries: number;
  reliabilityBackoffMs: number;
  reliabilityPollSeconds: number;
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

/** Reusable session preset (everything but the working directory). */
export interface SessionTemplate {
  id: string;
  name: string;
  description?: string;
  goal?: string;
  doneCriteria?: string;
  permissionMode?: PermissionMode;
  autonomy?: Autonomy;
  startMode?: SessionMode;
  createdAt: number;
  updatedAt: number;
}

/** Payload to create (omit id) or update (include id) a template (POST templateSave). */
export type TemplateInput = {
  id?: string;
  name: string;
  description?: string;
  goal?: string;
  doneCriteria?: string;
  permissionMode?: PermissionMode;
  autonomy?: Autonomy;
  startMode?: SessionMode;
};

/** A session lifecycle event a webhook can fire on. */
export type WebhookEvent = "done" | "error" | "stopped" | "needs-input" | "rate-limited";

/** An outbound webhook (Slack/Discord/JSON) fired on session events. */
export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  format?: "json" | "slack" | "discord";
  events?: WebhookEvent[];
  enabled?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Payload to create (omit id) or update (include id) a webhook (POST webhookSave). */
export type WebhookInput = {
  id?: string;
  name: string;
  url: string;
  format?: "json" | "slack" | "discord";
  events?: WebhookEvent[];
  enabled?: boolean;
};

/** A hand-started `claude` session the daemon drives via the Stop hook. */
export interface AttachedView {
  sessionId: string;
  goal: string;
  doneCriteria: string;
  /** Number of continue decisions injected so far (turns we've driven). */
  turns: number;
  /** Epoch ms the session was registered. */
  registeredAt: number;
  /** Epoch ms the Stop hook last fired (undefined until the first turn). */
  lastActivity?: number;
  /** Last decision we returned for this session. */
  lastAction?: "continue" | "stop";
  /** Reason text for the last decision. */
  lastReason?: string;
  /** True when the brain escalated — a human decision is wanted. */
  needsInput?: boolean;
}

/** A `claude` process running on this machine (GET /api/running-claude). */
export interface RunningClaude {
  pid: number;
  /** The --session-id it was started with, if detectable. */
  sessionId?: string;
  commandLine: string;
  /** True when this session id is already registered for attach driving. */
  attached?: boolean;
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
  /** Reusable session presets (newest-updated first). */
  templates?: SessionTemplate[];
  /** Outbound event webhooks (newest-updated first). */
  webhooks?: WebhookConfig[];
  /** Hand-started sessions driven via the Stop hook (newest-registered first). */
  attached?: AttachedView[];
}

/** A template the intake assistant thinks fits the drafted goal. */
export interface TemplateSuggestion {
  id: string;
  name: string;
  reason: string;
  score: number;
}

/** An existing same-project session the new one likely runs after. */
export interface DependsOnSuggestion {
  id: string;
  label: string;
  reason: string;
  score: number;
}

/** Goal intake assessment (POST /api/intake) — does the local brain think the goal is runnable? */
export interface IntakeResult {
  clarity: "clear" | "vague";
  assessment: string;
  questions: string[];
  suggestedGoal?: string;
  suggestedDoneCriteria?: string;
  suggestedTemplates?: TemplateSuggestion[];
  suggestedDependsOn?: DependsOnSuggestion[];
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
  /** auto-start schedule (every N minutes / daily HH:MM). */
  schedule?: SessionSchedule;
  /** auto-open-a-PR-on-done setting. */
  autoPr?: AutoPrConfig;
}

export type SessionPatch = Partial<{
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode: PermissionMode;
  autonomy: Autonomy;
  startMode: SessionMode;
  schedule: SessionSchedule | null;
  dependsOn: string[];
  autoPr: AutoPrConfig | null;
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
  | { type: "learnRevert"; scope: string; version: number }
  | { type: "templateSave"; template: TemplateInput }
  | { type: "templateDelete"; id: string }
  | { type: "saveAsTemplate"; id: string; name: string }
  | { type: "webhookSave"; webhook: WebhookInput }
  | { type: "webhookDelete"; id: string }
  | { type: "webhookTest"; id: string }
  | { type: "rollback"; id: string; snapshot: string }
  | { type: "detach"; id: string }
  | { type: "decisionFeedback"; id: string; feedback: "up" | "down" | "clear" }
  | { type: "decisionFeedbackAt"; id: string; runId: number; n: number; feedback: "up" | "down" | "clear" };

/** Per-session performance row (GET /api/analytics). */
export interface SessionAnalytics {
  id: string;
  goal: string;
  runs: number;
  turns: number;
  avgTurns: number;
  completedRuns: number;
  erroredRuns: number;
  successRate: number;
  interventionRate: number;
  decisions: { continue: number; stop: number; escalate: number };
  feedback: { up: number; down: number };
  lastRunAt: number | null;
}

/** Fleet + per-session analytics report (GET /api/analytics). */
export interface Analytics {
  generatedAt: number;
  fleet: {
    sessions: number;
    runs: number;
    turns: number;
    avgTurns: number;
    successRate: number;
    interventionRate: number;
    decisions: { continue: number; stop: number; escalate: number };
    feedback: { up: number; down: number };
  };
  sessions: SessionAnalytics[];
  daily: Array<{ day: string; runs: number; turns: number }>;
  learning: { globalVersions: number; projectProfiles: number; totalExamples: number };
}

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

/** One file's change within a turn diff. `added`/`removed` are -1 for binary. */
export interface FileDelta {
  file: string;
  added: number;
  removed: number;
}

/** The git delta an agent produced in a turn. */
export interface TurnDiff {
  files: FileDelta[];
  patch: string;
  truncated: boolean;
}

export interface TurnRow {
  n: number;
  injected_prompt: string | null;
  assistant_text: string | null;
  files_changed?: number | null;
  /** JSON-encoded TurnDiff, or null (parse with JSON.parse). */
  diff?: string | null;
  /** Pinned git sha of the worktree after this turn (rollback target), or null. */
  snapshot?: string | null;
}

export interface DecisionRow {
  n: number;
  action: "continue" | "stop" | "escalate";
  prompt?: string | null;
  reason?: string | null;
  /** Operator thumbs on this decision ('up'|'down'), or null/absent if unrated. */
  feedback?: "up" | "down" | null;
}

export interface RunDetail {
  run: RunRow | null;
  turns: TurnRow[];
  decisions: DecisionRow[];
  events: { type: string }[];
}
