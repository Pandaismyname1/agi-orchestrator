/** Shared types for the orchestrator. */

/** How claude renders its current screen, classified from clean emulator text. */
export type ScreenState = "working" | "ready" | "gate" | "unknown";

/** A session the daemon drives. */
export interface SessionConfig {
  /** Stable id used for the forced claude --session-id and the dashboard. */
  id: string;
  /** Working directory the claude session runs in (the project). */
  cwd: string;
  /** The high-level goal — handed to claude as the first prompt and to the brain as context. */
  goal: string;
  /** Plain-language "you are done when..." criteria the brain uses to decide STOP. */
  doneCriteria: string;
  /** Permission mode for claude. Looser modes = fewer interactive gates. */
  permissionMode?: "default" | "acceptEdits" | "auto" | "bypassPermissions";
  /** Per-session overrides of the global limits. */
  limits?: Partial<Limits>;
}

/** Guard rails. The real "budget" here is rate-limit/turn burn, not dollars. */
export interface Limits {
  /** Max autopilot turns before forced stop. */
  maxTurns: number;
  /** Max wall-clock minutes before forced stop. */
  maxWallClockMin: number;
  /** Stop if the brain produces N near-identical prompts in a row (ping-pong guard). */
  pingPongThreshold: number;
}

/** Local-LLM provider config (LM Studio / Ollama — both OpenAI-compatible). */
export interface ProviderConfig {
  /** e.g. http://localhost:1234/v1 (LM Studio) or http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  /** Model name as the provider exposes it (e.g. "qwen2.5-coder:14b"). */
  model: string;
  /** Usually ignored by local servers; default placeholder is fine. */
  apiKey?: string;
  /** Sampling temperature for the decision model. */
  temperature?: number;
}

export interface AppConfig {
  provider: ProviderConfig;
  limits: Limits;
  sessions: SessionConfig[];
  /** HTTP port for the dashboard + optional Stop-hook notifier. */
  port?: number;
}

/** The brain's decision after reading a finished turn. */
export interface Decision {
  action: "continue" | "stop";
  /** Next prompt to inject (when action === "continue"). */
  prompt?: string;
  /** Short human-readable rationale (shown in dashboard/logs). */
  reason: string;
}

/** Result of one driven turn. */
export interface TurnResult {
  /** The injected prompt that started this turn. */
  prompt: string;
  /** Claude's last assistant message text for this turn (from the transcript). */
  assistantText: string;
  /** Gates auto-accepted during this turn. */
  gatesHandled: number;
  /** Wall-clock ms the turn took. */
  durationMs: number;
}
