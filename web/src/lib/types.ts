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
}

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

export interface Snapshot {
  type: "snapshot";
  provider: Provider;
  budget?: Budget | null;
  sessions: SessionView[];
  focus?: FocusView;
  settings?: Settings;
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
}

export type SessionPatch = Partial<{
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode: PermissionMode;
  autonomy: Autonomy;
  startMode: SessionMode;
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
  | { type: "focus"; id: string }
  | { type: "add"; session: SessionInput }
  | { type: "update"; id: string; patch: SessionPatch }
  | { type: "remove"; id: string }
  | { type: "resolve"; id: string; choice: ResolveChoice }
  | { type: "setMode"; id: string; mode: SessionMode }
  | { type: "sendMessage"; id: string; text: string }
  | { type: "updateSettings"; settings: SettingsPatch };

/** Discovered on-disk Claude Code session (GET /api/discover). */
export interface DiscoveredSession {
  sessionId: string;
  cwd: string;
  summary: string;
  turns: number;
  lastActivity: number;
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
