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
  /**
   * Gate safety policy.
   * "guard" (default) — auto-approve safe gates; escalate dangerous ones (or
   *   default-deny if no human is watching).
   * "auto" — auto-approve every gate (the old behavior).
   */
  gatePolicy?: "guard" | "auto";
  /**
   * Operator persona — how readily the brain escalates decisions to you.
   * "cautious" asks more, "autonomous" asks less, "balanced" (default) in between.
   */
  autonomy?: "cautious" | "balanced" | "autonomous";
  /**
   * Mode the session starts in.
   * "autopilot" (default) — Qwen drives from the goal immediately.
   * "manual" — you drive: type to the agent yourself (Qwen silent) to seed
   *   context, then flip to autopilot when ready.
   */
  startMode?: "manual" | "autopilot";
  /** Per-session overrides of the global limits. */
  limits?: Partial<Limits>;
  /**
   * If set, resume this existing Claude Code session id (`claude --resume <id>`)
   * instead of starting a fresh one — used to adopt sessions that already exist
   * on disk. Its transcript becomes this session's transcript.
   */
  resumeId?: string;
  /**
   * The claude conversation UUID from this session's last run. Persisted so the
   * session can be CONTINUED (resumed in the same conversation) across restarts.
   */
  lastClaudeSessionId?: string;
  /**
   * Workflow dependencies: ids of sessions that must reach status `done` before
   * this one auto-starts. Empty/undefined = no dependencies (starts immediately).
   * Used by `startAll` and by auto-promotion when a dependency finishes. A start
   * request for a session with unmet dependencies parks it as `blocked`.
   */
  dependsOn?: string[];
  /**
   * Auto-start schedule: run this session every N minutes and/or daily at a local
   * HH:MM. Firing goes through the normal start path (respects concurrency, the
   * daily budget, real usage limits, and dependencies). Omit for manual-only.
   */
  schedule?: SessionSchedule;
  /**
   * Auto-open a pull request when the session reaches its done-criteria. Opt-in;
   * omit to disable. Requires the cwd to be a git repo with an "origin" remote and
   * the GitHub CLI (`gh`) installed + authenticated. The orchestrator commits the
   * agent's pending changes onto a fresh `agi/<id>-<slug>` branch, pushes it, and
   * opens the PR against `base` (default: origin's default branch).
   */
  autoPr?: AutoPrConfig;
}

/** Auto-PR-on-done settings (see SessionConfig.autoPr). */
export interface AutoPrConfig {
  /** "draft" opens a draft PR; "ready" opens a normal PR. */
  mode: "draft" | "ready";
  /** Base branch to target. Defaults to origin's default branch, else "main". */
  base?: string;
}

/**
 * When to auto-start a session. Two composable triggers; if both are set, either
 * one firing starts the session. A disabled schedule is kept but never fires.
 */
export interface SessionSchedule {
  /** Master switch. Defaults to enabled when a trigger is set. */
  enabled?: boolean;
  /** Re-run every N minutes (>= 1). */
  everyMinutes?: number;
  /** Re-run daily at this local time, "HH:MM" (24h). */
  dailyAt?: string;
}

/** Guard rails. The real "budget" here is rate-limit/turn burn, not dollars. */
export interface Limits {
  /** Max autopilot turns before forced stop. */
  maxTurns: number;
  /** Max wall-clock minutes before forced stop. */
  maxWallClockMin: number;
  /** Stop if the brain produces N near-identical prompts in a row (ping-pong guard). */
  pingPongThreshold: number;
  /** Escalate if no files change for this many turns in a row (stuck guard). 0 = off. */
  stuckTurns?: number;
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
  /** The every-turn brain: triages continue/stop/escalate. Keep this fast/cheap. */
  provider: ProviderConfig;
  /**
   * Optional SECOND local model used ONLY to regenerate escalation options (rare,
   * worth a bigger model). When omitted, the single `provider` does everything —
   * byte-identical to before. Must be a loopback endpoint (subscription-safe).
   */
  escalationProvider?: ProviderConfig;
  limits: Limits;
  sessions: SessionConfig[];
  /** HTTP port for the dashboard + optional Stop-hook notifier. */
  port?: number;
  /** Path to the local SQLite store (default ./agi.db). */
  dbPath?: string;
  /** Daily usage budget across all sessions (protects the subscription cap). */
  budget?: Budget;
  /**
   * Max sessions running at once. Extra started sessions queue and auto-start as
   * slots free up — so a fleet can't hammer the rate limit. Omit for no cap.
   */
  maxConcurrent?: number;
  /**
   * Default session settings applied to newly created sessions when the caller
   * doesn't specify them. Editable at runtime from the dashboard.
   */
  defaults?: {
    permissionMode?: SessionConfig["permissionMode"];
    autonomy?: SessionConfig["autonomy"];
  };
  /** Memory-preserving context compaction (save handoff → /compact → resume). */
  contextGuard?: ContextGuardOptions;
  /** Self-improvement / learning loop (operator-prompt tuning). Off by default. */
  learning?: LearningOptions;
  /** Remote access ("dispatch"): token auth + rate limiting for an exposed port. */
  dispatch?: DispatchOptions;
  /** Pause/resume on Claude's REAL subscription limits (read from /usage). */
  usageGuard?: import("./policy/usage.js").UsageGuardOptions;
  /** Brain-decision policy (confidence gating). */
  brain?: BrainOptions;
  /** Reusable session presets ("templates") for one-click new sessions. */
  templates?: SessionTemplate[];
  /**
   * Outbound webhooks fired on session lifecycle events (done / error / paused /
   * limited). Drives Slack / Discord / generic-JSON automations. Empty = none.
   */
  webhooks?: WebhookConfig[];
  /** Self-healing knobs: brain-call retries + auto-pause health-poll cadence. */
  reliability?: ReliabilityOptions;
  /** Structured logging (level + optional rotating file). Console-only if omitted. */
  logging?: LoggingOptions;
  /** Remote template registry (browse/install community recipes; publish your own). Off unless a url is set. */
  registry?: RegistryOptions;
}

/**
 * Remote template registry config (the "marketplace" network layer). Entirely
 * opt-in: with no `url`, browsing is disabled; with no `publishUrl`, publishing
 * is disabled. This is template DATA only — it never touches the local-only brain.
 */
export interface RegistryOptions {
  /** URL returning a JSON array of recipes (GET). Omit to disable browsing. */
  url?: string;
  /** URL a recipe is POSTed to when publishing. Omit to disable publishing. */
  publishUrl?: string;
  /** Optional bearer token sent on registry requests (publish, and fetch if needed). */
  token?: string;
}

/** Structured-logging config (see src/util/logger.ts). */
export interface LoggingOptions {
  /** Minimum level: "debug" | "info" | "warn" | "error". Default "info". */
  level?: "debug" | "info" | "warn" | "error";
  /** Append JSON lines to this file (rotated). Omit for console-only. */
  file?: string;
  /** Rotate when the file would exceed this many bytes. Default 5 MiB. */
  maxBytes?: number;
  /** Keep this many rotated files. Default 5. */
  maxFiles?: number;
}

/**
 * Reliability / self-healing tuning. All optional; sane defaults applied in
 * `normalizeReliability`. retries/backoff take effect when the brain LLM is
 * constructed (next daemon start); the health-poll interval applies to the next
 * launched run.
 */
export interface ReliabilityOptions {
  /** Transient-failure retry attempts for a brain call (0 disables). Default 3. */
  retries?: number;
  /** Base backoff in ms between retries (doubles each attempt). Default 400. */
  retryBackoffMs?: number;
  /** Seconds between health polls while auto-paused on an unreachable LLM. Default 15. */
  brainPollSeconds?: number;
}

/** A session lifecycle moment a webhook can subscribe to. */
export type WebhookEvent = "done" | "error" | "stopped" | "needs-input" | "rate-limited";

/**
 * An outbound webhook: POSTs a payload to `url` whenever a subscribed event fires.
 * `format` shapes the body so it drops straight into a Slack/Discord incoming
 * webhook, or stays a rich generic JSON for custom automations.
 */
export interface WebhookConfig {
  /** Stable id. */
  id: string;
  /** Display name, e.g. "Slack #builds". */
  name: string;
  /** Destination URL (use HTTPS). */
  url: string;
  /** Body shape: "json" (rich, default), "slack" ({text}), or "discord" ({content}). */
  format?: "json" | "slack" | "discord";
  /** Events that trigger it. Empty/undefined = every event. */
  events?: WebhookEvent[];
  /** Disabled webhooks are kept but never fire. Defaults to enabled. */
  enabled?: boolean;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

/**
 * A reusable session preset. Captures everything about a session EXCEPT the
 * working directory (the one thing that's always project-specific), so you can
 * spin up a new session from it by just picking a folder. Stored in config.json.
 */
export interface SessionTemplate {
  /** Stable id. */
  id: string;
  /** Display name, e.g. "Bug-fix sprint" or "GDPR audit". */
  name: string;
  /** Optional one-line description shown in the picker. */
  description?: string;
  /** Pre-filled goal (the first prompt handed to claude). */
  goal?: string;
  /** Pre-filled done criteria. */
  doneCriteria?: string;
  permissionMode?: SessionConfig["permissionMode"];
  autonomy?: SessionConfig["autonomy"];
  startMode?: SessionConfig["startMode"];
  /** Set when installed from the built-in starter catalog (stable catalog id). */
  catalogId?: string;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

/** Tuning for how the brain's raw decision is gated before it's acted on. */
export interface BrainOptions {
  /**
   * If a `continue` decision's self-reported confidence is BELOW this (0..1), it
   * is auto-escalated to the human instead of guessing. 0 (default) disables the
   * gate — behavior identical to before. `stop`/`escalate` already involve the
   * human, so they're never gated.
   */
  confidenceThreshold?: number;
  /**
   * Feed the brain a maintained running summary (+ a short fresh tail) instead of
   * the raw last-N messages. Off by default (raw history unchanged).
   */
  rollingSummary?: import("./brain/summary.js").RollingSummaryOptions;
}

/**
 * Remote-access controls for when the dashboard port is exposed to the internet.
 * With no token set, remote requests are REFUSED (fail-safe); local always works.
 */
export interface DispatchOptions {
  /**
   * Shared secret a remote client must present (Authorization: Bearer, X-AGI-Token,
   * or ?token=). Also read from env AGI_DISPATCH_TOKEN (env wins). Empty/unset ⇒
   * remote access disabled entirely.
   */
  token?: string;
  /**
   * Treat loopback (127.0.0.1/::1) requests as trusted and skip the token. Default
   * true (zero local friction; the Stop-hook posts locally). Set false when a local
   * tunnel (cloudflared/ngrok) makes remote traffic appear to come from localhost.
   */
  trustLocal?: boolean;
  /** Per-IP rate limits (remote only; local is never limited). */
  rateLimit?: RateLimitOptions;
}

/** Per-IP sliding-window rate-limit tunables (see src/server/rateLimit.ts). */
export interface RateLimitOptions {
  /** General request budget per IP. Default 300 requests / 60s. */
  windowMs?: number;
  maxRequestsPerWindow?: number;
  /** Stricter brute-force guard on auth FAILURES. Default 12 fails / 300s. */
  authWindowMs?: number;
  maxAuthFailures?: number;
}

/** Tunables for the self-improvement / learning loop (see src/learning/). */
export interface LearningOptions {
  /** Master switch. Off by default — the brain is byte-identical to baseline. */
  enabled?: boolean;
  /** How many past Claude Code sessions to mine. */
  scanLimit?: number;
  /** Max ranked examples fed to the synthesis LLM. */
  maxExamples?: number;
  /** Max few-shot examples kept inside a profile. */
  maxFewShot?: number;
  /** Hard char budget for the guidance injected into the operator prompt. */
  guidanceCharBudget?: number;
  /** Corrections held out from synthesis for the advisory replay-eval. */
  evalHeldOut?: number;
}

/** Tunables for the context-window manager (see policy/context.ts). */
export interface ContextGuardOptions {
  /** Master switch. Off by default. */
  enabled?: boolean;
  /** Approx model context window in tokens (e.g. 200_000 or 1_000_000). */
  window?: number;
  /** Compact once estimated use reaches this percent of the window. */
  compactAtPercent?: number;
  /** Handoff file written before compaction, relative to the session cwd. */
  handoffFile?: string;
  /** Don't compact again until at least this many turns have passed. */
  minTurnsBetween?: number;
}

/**
 * Daily usage budget. The real cost of this tool is the subscription's
 * rate-limit / weekly cap, not dollars — these caps stop runs before they
 * burn through it. Resets at local midnight. Omit a field for "no limit".
 */
export interface Budget {
  /** Max autopilot turns per day across all sessions. */
  maxTurnsPerDay?: number;
  /** Max wall-clock minutes per day across all sessions. */
  maxMinutesPerDay?: number;
}

/** The brain's decision after reading a finished turn. */
export interface Decision {
  /**
   * continue — inject `prompt` and keep going (routine, auto-handled).
   * stop     — done, or blocked in a way that means end the run.
   * escalate — a genuine human decision is needed: pause and surface `options`.
   */
  action: "continue" | "stop" | "escalate";
  /** Next prompt to inject (when action === "continue"). */
  prompt?: string;
  /** Short human-readable rationale (shown in dashboard/logs). */
  reason: string;
  /** One-line description of the decision the human must make (when action === "escalate"). */
  question?: string;
  /** Concrete choices for the human (when action === "escalate"). */
  options?: AttentionOption[];
  /**
   * The brain's self-reported confidence in this decision, 0..1 (1 = certain).
   * Undefined when the model didn't report one. A low-confidence `continue` is
   * auto-escalated to the human (see brain.confidenceThreshold).
   */
  confidence?: number;
}

/** One proposed way forward when a decision is escalated to the human. */
export interface AttentionOption {
  /** Short button label, e.g. "Use PostgreSQL". */
  label: string;
  /** One line on why / the tradeoff. */
  rationale: string;
  /** The exact instruction injected into claude if this option is chosen. */
  prompt: string;
}

/** A paused session waiting on a human decision. */
export interface AttentionRequest {
  id: string;
  sessionId: string;
  turnNumber: number;
  question: string;
  options: AttentionOption[];
  createdAt: number;
  /** "turn" = brain escalation; "gate" = a risky permission prompt awaiting approval. */
  kind?: "turn" | "gate";
}

/** How a human (or a fallback policy) resolves an AttentionRequest. */
export type Resolution =
  | { kind: "answer"; prompt: string; label: string }
  | { kind: "stop" };

/** A risky TUI gate (e.g. a destructive shell command) awaiting approval. */
export interface GateRequest {
  id: string;
  sessionId: string;
  /** What the gate wants to do, e.g. "Bash: rm -rf build". */
  summary: string;
}

/** How a risky gate is resolved: approve it, or deny (cancel) it. */
export type GateResolution = { kind: "approve" } | { kind: "deny" };

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
  /**
   * Git delta the agent produced this turn (set by the orchestrator when the cwd
   * is a git repo). Undefined for non-repo projects or when capture failed.
   */
  diff?: import("./git/diff.js").TurnDiff;
  /**
   * Pinned git snapshot sha of the working tree AFTER this turn (set when the cwd
   * is a git repo). Rolling back to it undoes every later turn.
   */
  snapshot?: string;
}
