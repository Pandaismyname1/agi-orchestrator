/**
 * Supervisor — manages all sessions for the dashboard. Holds a live record per
 * configured session (status, turns, last reply, last decision) updated from the
 * orchestrator event stream, plus a handle to the live ClaudeSession so the
 * dashboard can stream its screen and stop it.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runSession, type OrchestratorEvent, type RunOptions, type UserInput } from "../orchestrator.js";
import { ClaudeSession } from "../session/claudeSession.js";
import { LocalLLM } from "../brain/provider.js";
import { saveConfig } from "../config.js";
import { Recorder } from "../db/recorder.js";
import { BudgetTracker, type BudgetStatus } from "../policy/budget.js";
import { ContextGuard } from "../policy/context.js";
import { UsageGuard, type UsageStatus } from "../policy/usage.js";
import { decideNextStep, refineEscalation } from "../brain/decide.js";
import { assessGoal, type IntakeInput, type IntakeResult } from "../brain/intake.js";
import { suggestTemplates, suggestDependsOn } from "../policy/suggest.js";
import { isDue, hasActiveTrigger, parseHHMM } from "../policy/schedule.js";
import { restoreTo, type RestoreResult } from "../git/diff.js";
import { openPullRequest, defaultRunner, type Runner as PrRunner } from "../git/pr.js";
import { retryOptsFrom, brainPollMsFrom } from "../policy/reliability.js";
import { LearningService, emptyLearningSummary } from "../learning/service.js";
import { Notifier, type DeliveryResult, type NotifyContext } from "../notify/notifier.js";
import { createLogger, type Logger } from "../util/logger.js";
import type {
  DraftProposal,
  LearningSummary,
  OperatorProfile,
  ProfileScope,
} from "../learning/types.js";
import type { Store } from "../db/store.js";
import type {
  AppConfig,
  AttentionRequest,
  AutoPrConfig,
  GateResolution,
  Resolution,
  SessionConfig,
  SessionSchedule,
  SessionTemplate,
  WebhookConfig,
  WebhookEvent,
} from "../types.js";

/** Fields accepted when creating/updating a template (id optional = create). */
export interface TemplateInput {
  id?: string;
  name: string;
  description?: string;
  goal?: string;
  doneCriteria?: string;
  permissionMode?: SessionConfig["permissionMode"];
  autonomy?: SessionConfig["autonomy"];
  startMode?: SessionConfig["startMode"];
}

/** Fields accepted when creating/updating a webhook (id optional = create). */
export interface WebhookInput {
  id?: string;
  name: string;
  url: string;
  format?: WebhookConfig["format"];
  events?: WebhookEvent[];
  enabled?: boolean;
}

/** The session-runner the supervisor drives (real one is runSession; tests inject a stub). */
export type RunFn = (session: SessionConfig, opts: RunOptions) => Promise<void>;

export type SessionStatus =
  | "idle"
  | "queued"
  | "blocked" // waiting on workflow dependencies (a `dependsOn` session isn't done yet)
  | "running"
  | "manual" // active but waiting for the user to drive (Qwen paused)
  | "needs-input"
  | "rate-limited"
  | "paused" // auto-paused: the local brain (LLM) is unreachable; will resume when it's back
  | "stopped"
  | "done"
  | "error";

export type SessionMode = "manual" | "autopilot";

export interface SessionView {
  id: string;
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode: SessionConfig["permissionMode"];
  autonomy?: SessionConfig["autonomy"];
  /** Whether Qwen drives (autopilot) or the user drives (manual). */
  mode: SessionMode;
  status: SessionStatus;
  turns: number;
  elapsedMin: number;
  lastReply: string;
  lastDecision: string;
  /** Operator thumbs on the CURRENT/last brain decision ('up'|'down'), if rated. */
  lastDecisionFeedback?: "up" | "down";
  /** Aggregated thumbs tally across this session's decisions (the approval ratio). */
  feedback?: { up: number; down: number };
  error?: string;
  /** Present only while status === "needs-input": the open human decision. */
  attention?: AttentionRequest | null;
  /** True when the session has run before (so it can be CONTINUED, not just started). */
  canContinue: boolean;
  /** Workflow dependencies: ids this session runs after (empty = none). */
  dependsOn?: string[];
  /** Subset of `dependsOn` not yet `done` — non-empty only while waiting. */
  blockedBy?: string[];
  /** Auto-start schedule (every N minutes / daily HH:MM), if configured. */
  schedule?: SessionSchedule;
  /** Auto-open-a-PR-on-done setting, if configured. */
  autoPr?: AutoPrConfig;
  /** URL of the PR opened for this session's last completed run, if any. */
  prUrl?: string;
  /** Lifecycle of the auto-PR for the current/last run. */
  prState?: "opening" | "open" | "failed" | "skipped";
}

interface Managed extends SessionView {
  config: SessionConfig;
  sess?: ClaudeSession;
  stopRequested: boolean;
  /** The claude conversation UUID from the last run (for "continue" / resume). */
  claudeSessionId?: string;
  /** Set for a "continue" launch: resume this conversation id for this run only. */
  continueResumeId?: string;
  /** Set for a "continue" launch: the prompt to seed first this run only. */
  continueSeed?: string;
  /** Resolver for the open AttentionRequest's pending promise (if any). */
  resolveAttention?: (r: Resolution) => void;
  /** Resolver for an open dangerous-gate approval (if any). */
  resolveGate?: (r: GateResolution) => void;
  /** Resolver for the loop's manual-mode "wait for the user" promise (if any). */
  resolveUserInput?: (i: UserInput) => void;
  /** Wall-clock start of the current run (for live minute accounting). */
  startedAt?: number;
  /** Most recent /usage read while this session ran. */
  usage?: UsageStatus;
  /** Epoch ms this session last auto-fired from its schedule (seeds isDue). */
  lastFire?: number;
}

export class Supervisor {
  private readonly sessions = new Map<string, Managed>();
  private readonly llm: LocalLLM;
  /** Optional bigger LOCAL model for escalation-option refinement (multi-model brain). */
  private readonly heavyLlm?: LocalLLM;
  private readonly recorder?: Recorder;
  private budget: BudgetTracker;
  /** Real subscription-limit gate (Claude's /usage) — the primary pause control. */
  private readonly usageGuard: UsageGuard;
  /** Most recent /usage read from any session, for the dashboard + start gate. */
  private lastUsage?: UsageStatus;
  /** Pending auto-resume timers (session id → timer), fired at a limit's reset. */
  private readonly resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private readonly queue: string[] = [];
  private maxConcurrent: number;
  /** Self-improvement / learning loop (only when a store is available). */
  private readonly learning?: LearningService;
  /** Outbound event webhooks (Slack/Discord/JSON). Reads cfg.webhooks live. */
  private readonly notifier: Notifier;
  /** Periodic tick that auto-starts sessions whose schedule is due. */
  private scheduleTimer?: ReturnType<typeof setInterval>;
  /** Git/gh runner for auto-PR (injectable so it's testable without a real repo). */
  private readonly prRunner: PrRunner;
  /** Structured logger for unattended-run lifecycle events. */
  private readonly log: Logger;

  constructor(
    private readonly cfg: AppConfig,
    private readonly store?: Store,
    /** Optional brain override (e.g. a faster model, or a test stub). */
    private readonly decide?: RunOptions["decide"],
    /** Optional session-runner override (defaults to the real orchestrator). */
    private readonly runner: RunFn = runSession,
    /** Optional notifier override (tests inject one with a recording transport). */
    notifier?: Notifier,
    /** Optional git/gh runner for auto-PR (tests inject a recording stub). */
    prRunner?: PrRunner,
    /** Optional shared logger; defaults to a console-quiet one so tests stay silent. */
    log?: Logger,
  ) {
    this.prRunner = prRunner ?? defaultRunner;
    // When the server injects its logger we share it; otherwise default to a
    // file-only/quiet logger so unit tests don't print lifecycle chatter.
    this.log = log ?? createLogger({ ...(cfg.logging ?? {}), console: false });
    const retryOpts = retryOptsFrom(cfg.reliability);
    this.llm = new LocalLLM(cfg.provider, retryOpts);
    if (cfg.escalationProvider) this.heavyLlm = new LocalLLM(cfg.escalationProvider, retryOpts);
    this.budget = new BudgetTracker(store, cfg.budget);
    this.usageGuard = new UsageGuard(cfg.usageGuard);
    this.maxConcurrent = cfg.maxConcurrent && cfg.maxConcurrent > 0 ? cfg.maxConcurrent : Infinity;
    this.notifier = notifier ?? new Notifier(() => this.cfg.webhooks);
    if (store) this.learning = new LearningService(store, this.llm, cfg.learning, cfg.provider.model);
    if (store) this.recorder = new Recorder(store);
    for (const s of cfg.sessions) {
      this.sessions.set(s.id, {
        config: s,
        id: s.id,
        cwd: s.cwd,
        goal: s.goal,
        doneCriteria: s.doneCriteria,
        permissionMode: s.permissionMode,
        mode: s.startMode ?? "autopilot",
        status: "idle",
        turns: 0,
        elapsedMin: 0,
        lastReply: "",
        lastDecision: "",
        stopRequested: false,
        canContinue: false,
        // Restore the prior conversation id so a session stays continuable across restarts.
        claudeSessionId: s.lastClaudeSessionId,
        // Seed the schedule clock at boot so nothing fires before its first window.
        lastFire: Date.now(),
      });
      this.store?.upsertSession(s);
    }
    // Schedule tick: every 30s, auto-start any session whose schedule is due.
    // unref() so a pending tick never keeps the process alive on its own.
    this.scheduleTimer = setInterval(() => this.runDueSchedules(Date.now()), 30_000);
    this.scheduleTimer.unref?.();
  }

  health() {
    return this.llm.health();
  }

  /**
   * Goal intake assistant: ask the local brain whether a goal + done-criteria are
   * specific enough to run unattended and, if not, return sharpening questions +
   * tighter suggestions. One LLM call; subscription-safe (local provider).
   */
  async assessGoal(input: IntakeInput): Promise<IntakeResult> {
    // Clarity (one LLM call) and the deterministic history-based suggestions are
    // independent — compute both and merge. The suggestions never throw, so a
    // flaky assess still returns them (and vice-versa).
    const result = await assessGoal(this.llm, input);
    return { ...result, ...this.goalSuggestions(input) };
  }

  /**
   * Deterministic intake suggestions from the project's own history: which
   * templates fit the goal, and which existing same-project sessions this one
   * should run after (`dependsOn`). Pure over the live session/template lists.
   */
  private goalSuggestions(input: IntakeInput): Pick<IntakeResult, "suggestedTemplates" | "suggestedDependsOn"> {
    const cwd = input.cwd?.trim() ? path.resolve(input.cwd.trim()) : undefined;
    const sessions = [...this.sessions.values()].map((m) => ({ id: m.id, goal: m.goal, cwd: m.cwd }));
    const templates = suggestTemplates(input.goal, this.cfg.templates ?? [], 3);
    const dependsOn = suggestDependsOn({ cwd, goal: input.goal }, sessions, 3);
    return {
      suggestedTemplates: templates.length ? templates : undefined,
      suggestedDependsOn: dependsOn.length ? dependsOn : undefined,
    };
  }

  /**
   * Roll a session's working tree back to a per-turn snapshot (undo every later
   * turn). Guarded: the session must exist and be idle (no agent touching the
   * repo), and `sha` must be a snapshot THIS session actually recorded. Pins a
   * backup of the current state first so the rollback is itself recoverable.
   */
  rollback(sessionId: string, sha: string): RestoreResult {
    const m = this.sessions.get(sessionId);
    if (!m) throw new Error(`no session with id "${sessionId}".`);
    if (["running", "queued", "needs-input", "manual", "blocked", "paused"].includes(m.status)) {
      throw new Error("stop the session before rolling back its working tree.");
    }
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("invalid snapshot id.");
    if (!this.store || !this.store.snapshotBelongsToSession(sessionId, sha)) {
      throw new Error("that snapshot doesn't belong to this session.");
    }
    const res = restoreTo(m.config.cwd, sha);
    if (res.ok) m.lastDecision = `rolled back to an earlier snapshot${res.backupSha ? ` (backup ${res.backupSha.slice(0, 8)})` : ""}`;
    return res;
  }

  /**
   * Auto-start any session whose schedule is due at `now`. Only fires sessions
   * that aren't already active (running/queued/paused/blocked); firing reuses the
   * normal start() path, so concurrency cap, daily budget, real usage limits, and
   * workflow dependencies all still apply. Public so it's unit-testable with an
   * injected clock; the constructor's interval calls it with Date.now().
   */
  runDueSchedules(now: number): void {
    const ACTIVE = ["running", "queued", "needs-input", "manual", "blocked", "paused"];
    for (const m of this.sessions.values()) {
      const schedule = m.config.schedule;
      if (!hasActiveTrigger(schedule)) continue;
      if (ACTIVE.includes(m.status)) continue; // don't pile a second run on an active one
      if (isDue(schedule, now, m.lastFire ?? now)) {
        m.lastFire = now;
        m.lastDecision = "auto-started on schedule";
        this.start(m.id);
      }
    }
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((m) => {
      const v = toView(m);
      // Aggregated thumbs ratio per agent (only when there's something rated).
      if (this.store) {
        const f = this.store.feedbackStats(m.id);
        if (f.up || f.down) v.feedback = f;
      }
      return v;
    });
  }

  /** Normalized reliability settings (clamped), for the dashboard + tuning. */
  reliabilitySettings(): { retries: number; retryBackoffMs: number; brainPollSeconds: number } {
    const r = retryOptsFrom(this.cfg.reliability);
    return {
      retries: r.retries ?? 3,
      retryBackoffMs: r.baseMs ?? 400,
      brainPollSeconds: brainPollMsFrom(this.cfg.reliability) / 1000,
    };
  }

  /**
   * Apply a reliability patch (clamped) and persist. retries/backoff take effect
   * on the next daemon start (the brain LLM is constructed once); the poll cadence
   * applies to the next launched run.
   */
  setReliability(patch: { retries?: number; retryBackoffMs?: number; brainPollSeconds?: number }): void {
    const cur = { ...this.cfg.reliability };
    if (patch.retries !== undefined) cur.retries = patch.retries;
    if (patch.retryBackoffMs !== undefined) cur.retryBackoffMs = patch.retryBackoffMs;
    if (patch.brainPollSeconds !== undefined) cur.brainPollSeconds = patch.brainPollSeconds;
    this.cfg.reliability = cur;
    this.persist();
  }

  /**
   * Record operator thumbs on a session's CURRENT (last) brain decision. Persists
   * to the decisions table and reflects it live so the dashboard updates at once.
   * `feedback` of "clear" removes a prior rating. No-op if nothing is recorded yet.
   */
  rateDecision(sessionId: string, feedback: "up" | "down" | "clear"): { ok: boolean; error?: string } {
    const m = this.sessions.get(sessionId);
    if (!m) return { ok: false, error: `unknown session ${sessionId}` };
    if (!this.store) return { ok: false, error: "no persistent store" };
    const value = feedback === "clear" ? null : feedback;
    const rated = this.store.setLatestDecisionFeedback(sessionId, value);
    if (!rated) return { ok: false, error: "no decision to rate yet" };
    m.lastDecisionFeedback = value ?? undefined;
    return { ok: true };
  }

  /**
   * Rate a specific past decision (the one after turn `turnN` of `runId`) — backs
   * the per-turn thumbs in the history timeline. Scoped to the session so a client
   * can't rate another session's runs.
   */
  rateDecisionAt(
    sessionId: string,
    runId: number,
    turnN: number,
    feedback: "up" | "down" | "clear",
  ): { ok: boolean; error?: string } {
    const m = this.sessions.get(sessionId);
    if (!m) return { ok: false, error: `unknown session ${sessionId}` };
    if (!this.store) return { ok: false, error: "no persistent store" };
    const value = feedback === "clear" ? null : feedback;
    const ok = this.store.setDecisionFeedback(sessionId, runId, turnN, value);
    return ok ? { ok: true } : { ok: false, error: "no matching decision for this session" };
  }

  /** Current clean screen for one session (empty if not running). */
  screen(id: string): string {
    const m = this.sessions.get(id);
    return m?.sess?.isAlive ? m.sess.screenText() : "";
  }

  /** Live (in-progress) usage across running sessions, for budget accounting. */
  private liveUsage(): { turns: number; minutes: number } {
    let turns = 0;
    let minutes = 0;
    for (const m of this.sessions.values()) {
      if (["running", "needs-input", "manual", "paused"].includes(m.status)) {
        turns += m.turns;
        if (m.startedAt) minutes += (Date.now() - m.startedAt) / 60_000;
      }
    }
    return { turns, minutes };
  }

  /** Today's budget status (persisted + live). Exposed for the dashboard. */
  budgetStatus(): BudgetStatus {
    return this.budget.status(this.liveUsage());
  }

  /** The latest real /usage limits read from Claude, for the dashboard. */
  latestUsage(): UsageStatus | undefined {
    return this.lastUsage;
  }

  /** (Re)schedule an auto-resume wakeup for a limit-paused session. */
  private scheduleResume(id: string, delayMs: number): void {
    this.clearResumeTimer(id);
    this.resumeTimers.set(
      id,
      setTimeout(() => {
        this.resumeTimers.delete(id);
        const m = this.sessions.get(id);
        // Session removed, or no longer paused (the user started/stopped it) — do
        // nothing, and DON'T touch the global lastUsage that other sessions gate on.
        if (!m || m.status !== "rate-limited") return;
        // Drop only this read so the start gate doesn't refuse; the orchestrator
        // re-reads fresh /usage at launch and re-pauses if the limit is still spent.
        this.lastUsage = undefined;
        m.usage = undefined;
        this.start(id);
      }, delayMs),
    );
  }

  /** Cancel any pending auto-resume timer for a session. */
  private clearResumeTimer(id: string): void {
    const t = this.resumeTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.resumeTimers.delete(id);
    }
  }

  /**
   * Update the concurrency cap at runtime. Lowering it never stops a running
   * session (it just won't pump new ones until the count drops below the cap);
   * raising it immediately fills freed slots from the queue.
   */
  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n > 0 ? n : Infinity;
    this.pump();
  }

  /**
   * Update the daily budget limits at runtime. Rebuilds the BudgetTracker from
   * the (already mutated) cfg.budget so the new caps take effect immediately.
   */
  setBudgetLimits(): void {
    this.budget = new BudgetTracker(this.store, this.cfg.budget);
  }

  /** Effective `dependsOn` for a node, with one node's edges optionally overridden. */
  private depsOf(nodeId: string, override: { id: string; deps: string[] }): string[] {
    if (nodeId === override.id) return override.deps;
    return this.sessions.get(nodeId)?.config.dependsOn ?? [];
  }

  /** True if `target` is reachable from `from` by following `dependsOn` edges. */
  private reaches(from: string, target: string, override: { id: string; deps: string[] }): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of this.depsOf(cur, override)) stack.push(d);
    }
    return false;
  }

  /**
   * Clean a proposed `dependsOn` list for session `id`: trim, dedupe, drop self
   * and unknown ids, then reject any edge that would create a cycle. Returns the
   * sanitized list to store.
   */
  private normalizeDeps(id: string, deps: string[] | undefined): string[] {
    const clean = [...new Set((deps ?? []).map((s) => String(s).trim()).filter(Boolean))].filter(
      (d) => d !== id && this.sessions.has(d),
    );
    for (const d of clean) {
      if (this.reaches(d, id, { id, deps: clean })) {
        throw new Error(
          `dependency cycle: "${shortLabel(this.sessions.get(d))}" already runs after this session.`,
        );
      }
    }
    return clean;
  }

  /**
   * Workflow dependencies that are not yet satisfied for a session: the ids in
   * `dependsOn` whose session exists and is not `done`. Unknown ids (deleted
   * sessions) are ignored so a workflow can't wedge forever on a removed step.
   */
  private unmetDeps(m: Managed): string[] {
    const deps = m.config.dependsOn ?? [];
    return deps.filter((depId) => {
      const dep = this.sessions.get(depId);
      return dep ? dep.status !== "done" : false;
    });
  }

  /**
   * Start any `blocked` session whose dependencies have all finished. Called
   * whenever a session reaches `done`, so a workflow chains forward by itself.
   */
  private promoteReady(): void {
    for (const m of this.sessions.values()) {
      if (m.status === "blocked" && this.unmetDeps(m).length === 0) {
        m.status = "idle"; // clear the gate so start() will actually launch/queue it
        m.blockedBy = undefined;
        this.start(m.id);
      }
    }
  }

  /** Request a session to run: launch now if a slot is free, else queue it. */
  start(id: string): void {
    const m = this.sessions.get(id);
    if (!m || ["running", "queued", "needs-input", "manual", "paused"].includes(m.status)) return;
    // Workflow gate: hold the session as `blocked` until every session it
    // depends on has finished. promoteReady() releases it when they're done.
    const unmet = this.unmetDeps(m);
    if (unmet.length > 0) {
      m.status = "blocked";
      m.blockedBy = unmet;
      const names = unmet.map((d) => shortLabel(this.sessions.get(d))).join(", ");
      m.lastDecision = `blocked — waiting on ${names}`;
      return;
    }
    m.blockedBy = undefined;
    // Refuse to start when a REAL subscription limit is spent (the orchestrator
    // re-reads /usage at launch, so a stale spent reading just defers the start
    // until the next slot; it's cleared when an auto-resume fires after a reset).
    if (this.usageGuard.enabled && this.lastUsage) {
      const v = this.usageGuard.verdict(this.lastUsage);
      if (v.blocked) {
        m.lastDecision = `blocked — ${v.reason}`;
        return;
      }
    } else if (!this.usageGuard.enabled) {
      const b = this.budgetStatus();
      if (b.exceeded) {
        m.lastDecision = `blocked — ${b.reason}`;
        return; // legacy daily budget (only when the usage gate is off)
      }
    }
    if (this.running.size >= this.maxConcurrent) {
      m.status = "queued";
      m.lastDecision = "queued — waiting for a free slot";
      if (!this.queue.includes(id)) this.queue.push(id);
      return;
    }
    this.launch(m);
  }

  /** Start enough queued sessions to fill the concurrency cap. */
  private pump(): void {
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const nm = this.sessions.get(next);
      if (nm && nm.status === "queued") this.launch(nm);
    }
  }

  private launch(m: Managed): void {
    this.running.add(m.id);
    m.status = "running";
    m.stopRequested = false;
    m.error = undefined;
    m.turns = 0;
    m.lastReply = "";
    m.lastDecision = "";
    m.attention = null;
    m.mode = m.config.startMode ?? "autopilot";
    m.startedAt = Date.now();
    // A fresh run supersedes any PR from the previous one.
    m.prState = undefined;
    m.prUrl = undefined;
    this.log.info("session launch", { session: m.id, goal: m.goal, mode: m.mode });

    // One-shot "continue" parameters (consumed by this launch only).
    const resumeId = m.continueResumeId;
    const seedPrompt = m.continueSeed;
    m.continueResumeId = undefined;
    m.continueSeed = undefined;

    // Brain wrapper: inject the approved operator profile (learning, global ⊕
    // per-cwd) and, when a fast-pass escalates, refine its options with the
    // bigger local model (multi-model brain). Both are no-ops when unconfigured,
    // so behavior is identical to baseline. A test-stub `this.decide` wins as-is.
    const learning = this.learning;
    const heavy = this.heavyLlm;
    const confThreshold = this.cfg.brain?.confidenceThreshold ?? 0;
    const wantsWrapper = (learning?.enabled || heavy || confThreshold > 0) && !this.decide;
    const decide: RunOptions["decide"] = wantsWrapper
      ? async (llm, session, lastText, turnNumber, history, repoState, projectSummary) => {
          const guidance = learning?.enabled ? learning.guidanceFor(session.cwd) : undefined;
          // decideNextStep applies the low-confidence gate (continue → escalate)
          // internally, so a gated decision flows straight into heavy refinement.
          const decision = await decideNextStep(
            llm, session, lastText, turnNumber, history, guidance, repoState, confThreshold, projectSummary,
          );
          if (decision.action === "escalate" && heavy) {
            return refineEscalation(heavy, session, lastText, turnNumber, history, repoState, decision);
          }
          return decision;
        }
      : this.decide;

    void this.runner(m.config, {
      llm: this.llm,
      limits: this.cfg.limits,
      decide,
      contextGuard: new ContextGuard(this.cfg.contextGuard),
      usageGuard: this.usageGuard,
      rollingSummary: this.cfg.brain?.rollingSummary,
      brainPollMs: brainPollMsFrom(this.cfg.reliability),
      resumeId,
      seedPrompt,
      onSession: (s) => {
        m.sess = s;
        // Remember the conversation id so the session can be continued later.
        if (m.claudeSessionId !== s.sessionId) {
          m.claudeSessionId = s.sessionId;
          if (m.config.lastClaudeSessionId !== s.sessionId) {
            m.config.lastClaudeSessionId = s.sessionId;
            this.persist();
          }
        }
      },
      // Manual/autopilot mode: the loop reads this each iteration.
      mode: () => m.mode,
      // MANUAL: park the loop until the user sends a message, switches, or stops.
      waitForInput: () =>
        new Promise<UserInput>((resolve) => {
          if (m.status === "running") m.status = "manual";
          m.resolveUserInput = (i) => {
            m.resolveUserInput = undefined;
            if (i.kind !== "stop") m.status = "running";
            resolve(i);
          };
        }),
      // Stop on operator request. Real subscription limits are handled inside the
      // loop by the usage guard; the legacy daily budget only gates when that's off.
      shouldStop: () => {
        if (m.stopRequested) return true;
        if (!this.usageGuard.enabled) {
          const b = this.budgetStatus();
          return b.exceeded ? b.reason : false;
        }
        return false;
      },
      // Pause on a real human decision: flip to needs-input and hand back a
      // promise the dashboard resolves when the user picks an option.
      resolveAttention: (req) =>
        new Promise<Resolution>((resolve) => {
          m.attention = req;
          m.status = "needs-input";
          this.notify(m, "needs-input", req.question);
          m.resolveAttention = (r) => {
            m.attention = null;
            m.resolveAttention = undefined;
            if (m.status === "needs-input") m.status = "running";
            resolve(r);
          };
        }),
      // A dangerous gate pauses the run for an Approve/Deny — reuses needs-input.
      resolveGate: (req) =>
        new Promise<GateResolution>((resolve) => {
          m.attention = {
            id: req.id,
            sessionId: m.id,
            turnNumber: m.turns,
            question: `⚠ Approve risky action — ${req.summary}`,
            options: [
              { label: "Approve — run it", rationale: "let claude proceed with this", prompt: "" },
              { label: "Deny — cancel it", rationale: "block it; claude continues another way", prompt: "" },
            ],
            createdAt: Date.now(),
            kind: "gate",
          };
          m.status = "needs-input";
          this.notify(m, "needs-input", `risky action — ${req.summary}`);
          m.resolveGate = (r) => {
            m.attention = null;
            m.resolveGate = undefined;
            if (m.status === "needs-input") m.status = "running";
            resolve(r);
          };
        }),
      onEvent: (e) => {
        this.onEvent(m, e);
        this.recorder?.record(e);
      },
    }).then(() => {
      // If the loop ended without an explicit stop/error event, mark done.
      if (m.status === "running") m.status = "done";
      m.sess = undefined;
      this.running.delete(m.id);
      this.pump(); // free slot -> start the next queued session
      // If this session finished, release any workflow steps waiting on it.
      if (m.status === "done") this.promoteReady();
      // Fire the terminal-state webhook (rate-limited is handled in onEvent, so
      // a paused-on-limit run doesn't double-notify here).
      if (m.status === "done") this.notify(m, "done", undefined);
      else if (m.status === "stopped") this.notify(m, "stopped", undefined);
      else if (m.status === "error") this.notify(m, "error", m.error);
      const endFields = { session: m.id, turns: m.turns, elapsedMin: Number(m.elapsedMin.toFixed(1)) };
      if (m.status === "error") this.log.error("session ended", { ...endFields, status: m.status, error: m.error });
      else this.log.info("session ended", { ...endFields, status: m.status });
      // Auto-open a PR if this session met its done-criteria and opted in.
      if (m.status === "done" && m.config.autoPr) void this.maybeOpenPr(m);
    });
  }

  /**
   * Resolve an open human-decision for a session: pick an option by index, send
   * a custom prompt, or stop. No-op if the session isn't currently waiting.
   */
  resolveAttention(id: string, choice: { optionIndex?: number; customPrompt?: string; stop?: boolean }): void {
    const m = this.sessions.get(id);
    if (!m) return;

    // Dangerous-gate approval: option 0 = approve, anything else = deny.
    if (m.resolveGate) {
      if (choice.stop) m.stopRequested = true; // deny + stop the run
      const approve = choice.optionIndex === 0 && !choice.customPrompt && !choice.stop;
      m.resolveGate({ kind: approve ? "approve" : "deny" });
      return;
    }

    if (!m.resolveAttention || !m.attention) return;
    if (choice.stop) {
      m.resolveAttention({ kind: "stop" });
      return;
    }
    if (typeof choice.customPrompt === "string" && choice.customPrompt.trim()) {
      m.resolveAttention({ kind: "answer", prompt: choice.customPrompt.trim(), label: "custom" });
      return;
    }
    const opt = m.attention.options[choice.optionIndex ?? -1];
    if (opt) m.resolveAttention({ kind: "answer", prompt: opt.prompt, label: opt.label });
  }

  startAll(): void {
    for (const id of this.sessions.keys()) this.start(id);
  }

  /**
   * Fleet emergency stop: stop every session (running, queued, blocked, paused,
   * or waiting on a decision/gate). A queued/blocked session just drops back to
   * idle; an active one is torn down. Safe to call repeatedly.
   */
  stopAll(): void {
    for (const m of this.sessions.values()) {
      if (m.status === "blocked") {
        m.status = "idle";
        m.blockedBy = undefined;
        m.lastDecision = "stopped by operator";
        continue;
      }
      this.stop(m.id);
    }
  }

  /** Switch a running session between manual (you drive) and autopilot (Qwen drives). */
  setMode(id: string, mode: SessionMode): void {
    const m = this.sessions.get(id);
    if (!m || m.mode === mode) return;
    m.mode = mode;
    // Flipping to autopilot while the loop is parked on manual input: unblock it.
    if (mode === "autopilot" && m.resolveUserInput) {
      const resolve = m.resolveUserInput;
      m.resolveUserInput = undefined;
      resolve({ kind: "switch" });
    }
    // Flipping to manual while autopilot runs takes effect after the current turn
    // (the loop reads mode() at the top of the next iteration).
  }

  /** Send a manual message straight to the agent (only while it's awaiting input). */
  sendMessage(id: string, text: string): void {
    const m = this.sessions.get(id);
    const t = text.trim();
    if (!m || !m.resolveUserInput || !t) return;
    const resolve = m.resolveUserInput;
    m.resolveUserInput = undefined;
    resolve({ kind: "message", text: t });
  }

  // ---- learning loop (A3) — propose / approve / revert --------------------

  /** Always returns a summary (a disabled/empty one when there's no store). */
  learningSummary(): LearningSummary {
    return this.learning ? this.learning.summary() : emptyLearningSummary();
  }
  /** Mine + synthesize a draft profile for a scope (LLM call; may take a moment). */
  async learnSynthesize(scope?: ProfileScope): Promise<DraftProposal> {
    if (!this.learning) throw new Error("learning is unavailable (no persistent store).");
    return this.learning.synthesize(scope);
  }
  learnApprove(scope?: ProfileScope): OperatorProfile {
    if (!this.learning) throw new Error("learning is unavailable.");
    return this.learning.approve(scope);
  }
  learnReject(scope?: ProfileScope): void {
    this.learning?.reject(scope);
  }
  learnRevert(scope: ProfileScope, version: number): void {
    if (!this.learning) throw new Error("learning is unavailable.");
    this.learning.revert(scope, version);
  }
  learningDraft(scope?: ProfileScope): DraftProposal | null {
    return this.learning ? this.learning.getDraft(scope) : null;
  }
  learningVersions(scope?: ProfileScope): OperatorProfile[] {
    return this.learning ? this.learning.listVersions(scope) : [];
  }

  // ---- session templates (reusable presets) -------------------------------

  /** All saved templates, most-recently-updated first. */
  listTemplates(): SessionTemplate[] {
    return [...(this.cfg.templates ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Create (no id) or update (matching id) a template; persist. */
  saveTemplate(input: TemplateInput): SessionTemplate {
    const name = (input.name ?? "").trim();
    if (!name) throw new Error("template name is required.");
    const list = this.cfg.templates ?? (this.cfg.templates = []);
    const now = Date.now();
    const clean = (s?: string) => (s ?? "").trim() || undefined;
    const fields = {
      name,
      description: clean(input.description),
      goal: clean(input.goal),
      doneCriteria: clean(input.doneCriteria),
      permissionMode: input.permissionMode,
      autonomy: input.autonomy,
      startMode: input.startMode,
    };
    const id = (input.id ?? "").trim();
    const existing = id ? list.find((t) => t.id === id) : undefined;
    if (existing) {
      Object.assign(existing, fields, { updatedAt: now });
      this.persist();
      return existing;
    }
    const tpl: SessionTemplate = { id: id || randomUUID(), ...fields, createdAt: now, updatedAt: now };
    list.push(tpl);
    this.persist();
    return tpl;
  }

  /** Delete a template by id; persist. No-op if it doesn't exist. */
  deleteTemplate(id: string): void {
    const list = this.cfg.templates;
    if (!list) return;
    const i = list.findIndex((t) => t.id === id);
    if (i >= 0) {
      list.splice(i, 1);
      this.persist();
    }
  }

  /** Snapshot an existing session's settings into a new reusable template. */
  saveSessionAsTemplate(sessionId: string, name: string): SessionTemplate {
    const m = this.sessions.get(sessionId);
    if (!m) throw new Error(`no session with id "${sessionId}".`);
    return this.saveTemplate({
      name,
      goal: m.config.goal,
      doneCriteria: m.config.doneCriteria,
      permissionMode: m.config.permissionMode,
      autonomy: m.config.autonomy,
      startMode: m.config.startMode,
    });
  }

  // ---- outbound webhooks / event notifications (automation suite) ----------

  /** Fire-and-forget a lifecycle webhook for a session. Never throws. */
  private notify(m: Managed, event: WebhookEvent, detail?: string): void {
    if (!this.notifier.active) return;
    const ctx: NotifyContext = {
      id: m.id,
      label: shortLabel(m),
      cwd: m.cwd,
      goal: m.goal,
      status: m.status,
      turns: m.turns,
      elapsedMin: m.elapsedMin,
      detail: detail?.trim() || undefined,
    };
    void this.notifier.fire(event, ctx).catch(() => {});
  }

  /**
   * Open a PR for a session that just hit its done-criteria (Tier 3 #10). Reflects
   * progress in the live view (`prState`/`prUrl`/`lastDecision`) so the dashboard
   * shows it. Best-effort: any failure or skip is recorded, never thrown.
   */
  private async maybeOpenPr(m: Managed): Promise<void> {
    const autoPr = m.config.autoPr;
    if (!autoPr) return;
    m.prState = "opening";
    m.prUrl = undefined;
    m.lastDecision = `opening ${autoPr.mode === "draft" ? "draft " : ""}PR…`;
    try {
      const res = await openPullRequest(
        m.cwd,
        {
          mode: autoPr.mode,
          base: autoPr.base,
          sessionId: m.id,
          goal: m.goal,
          doneCriteria: m.doneCriteria,
          turns: m.turns,
        },
        this.prRunner,
      );
      if (res.ok && res.url) {
        m.prState = "open";
        m.prUrl = res.url;
        m.lastDecision = `✅ opened PR: ${res.url}`;
        this.log.info("auto-PR opened", { session: m.id, url: res.url, mode: autoPr.mode });
      } else if (res.skipped) {
        m.prState = "skipped";
        m.lastDecision = `PR skipped — ${res.reason ?? "nothing to open"}`;
        this.log.info("auto-PR skipped", { session: m.id, reason: res.reason ?? "nothing to open" });
      } else {
        m.prState = "failed";
        m.lastDecision = `PR failed — ${res.reason ?? "unknown error"}`;
        this.log.warn("auto-PR failed", { session: m.id, reason: res.reason ?? "unknown error" });
      }
    } catch (e) {
      m.prState = "failed";
      const reason = e instanceof Error ? e.message : String(e);
      m.lastDecision = `PR failed — ${reason}`;
      this.log.error("auto-PR threw", { session: m.id, error: reason });
    }
  }

  /** All configured webhooks, most-recently-updated first. */
  listWebhooks(): WebhookConfig[] {
    return [...(this.cfg.webhooks ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Create (no id) or update (matching id) a webhook; persist. */
  saveWebhook(input: WebhookInput): WebhookConfig {
    const name = (input.name ?? "").trim();
    const url = (input.url ?? "").trim();
    if (!name) throw new Error("webhook name is required.");
    if (!/^https?:\/\//i.test(url)) throw new Error("webhook url must start with http:// or https://.");
    const list = this.cfg.webhooks ?? (this.cfg.webhooks = []);
    const now = Date.now();
    const fields = {
      name,
      url,
      format: input.format ?? "json",
      events: input.events && input.events.length ? [...new Set(input.events)] : undefined,
      enabled: input.enabled !== false,
    };
    const id = (input.id ?? "").trim();
    const existing = id ? list.find((w) => w.id === id) : undefined;
    if (existing) {
      Object.assign(existing, fields, { updatedAt: now });
      this.persist();
      return existing;
    }
    const hook: WebhookConfig = { id: id || randomUUID(), ...fields, createdAt: now, updatedAt: now };
    list.push(hook);
    this.persist();
    return hook;
  }

  /** Delete a webhook by id; persist. No-op if it doesn't exist. */
  deleteWebhook(id: string): void {
    const list = this.cfg.webhooks;
    if (!list) return;
    const i = list.findIndex((w) => w.id === id);
    if (i >= 0) {
      list.splice(i, 1);
      this.persist();
    }
  }

  /** Send a sample payload to one webhook so the operator can confirm it works. */
  async testWebhook(id: string): Promise<DeliveryResult> {
    const hook = this.cfg.webhooks?.find((w) => w.id === id);
    if (!hook) throw new Error(`no webhook with id "${id}".`);
    return this.notifier.test(hook);
  }

  /**
   * Continue a FINISHED session in the SAME claude conversation: optionally edit
   * the goal / done-criteria / start-mode, then resume the prior conversation and
   * inject the next instruction (or the edited goal). No-op while it's active.
   */
  continueSession(
    id: string,
    patch: { goal?: string; doneCriteria?: string; instruction?: string; startMode?: SessionMode },
  ): void {
    const m = this.sessions.get(id);
    if (!m) throw new Error(`no session with id "${id}".`);
    if (["running", "queued", "needs-input", "manual", "paused"].includes(m.status)) {
      throw new Error("session is still active — stop it before continuing.");
    }
    const resumeId = m.claudeSessionId ?? m.config.lastClaudeSessionId;
    if (!resumeId) throw new Error("this session hasn't run yet — start it instead.");

    if (patch.goal?.trim()) {
      m.config.goal = patch.goal.trim();
      m.goal = m.config.goal;
    }
    if (patch.doneCriteria?.trim()) {
      m.config.doneCriteria = patch.doneCriteria.trim();
      m.doneCriteria = m.config.doneCriteria;
    }
    if (patch.startMode) m.config.startMode = patch.startMode;

    // Resume the prior conversation and seed the next instruction (else the goal).
    m.continueResumeId = resumeId;
    m.continueSeed = patch.instruction?.trim() || m.config.goal;

    this.store?.upsertSession(m.config);
    this.persist();
    this.start(id);
  }

  /** Create a new session, add it to the live map as "idle", and persist. */
  addSession(input: {
    id?: string;
    cwd: string;
    goal: string;
    doneCriteria: string;
    permissionMode?: SessionConfig["permissionMode"];
    autonomy?: SessionConfig["autonomy"];
    startMode?: SessionConfig["startMode"];
    resumeId?: SessionConfig["resumeId"];
    dependsOn?: string[];
    schedule?: SessionSchedule;
    autoPr?: AutoPrConfig;
  }): SessionView {
    const cwd = (input.cwd ?? "").trim();
    const goal = (input.goal ?? "").trim();
    const doneCriteria = (input.doneCriteria ?? "").trim();
    if (!cwd) throw new Error("cwd is required.");
    if (!goal) throw new Error("goal is required.");
    if (!doneCriteria) throw new Error("doneCriteria is required.");
    validateSessionEnums(input);

    const id = (input.id ?? "").trim() || randomUUID();
    if (this.sessions.has(id)) throw new Error(`a session with id "${id}" already exists.`);

    const dependsOn = this.normalizeDeps(id, input.dependsOn);
    const schedule = normalizeSchedule(input.schedule);
    const autoPr = normalizeAutoPr(input.autoPr);
    const config: SessionConfig = {
      id,
      cwd: path.resolve(cwd),
      goal,
      doneCriteria,
      permissionMode: input.permissionMode ?? "acceptEdits",
      autonomy: input.autonomy ?? "balanced",
      startMode: input.startMode ?? "autopilot",
      resumeId: input.resumeId,
      ...(dependsOn.length ? { dependsOn } : {}),
      ...(schedule ? { schedule } : {}),
      ...(autoPr ? { autoPr } : {}),
    };
    const m: Managed = {
      config,
      id,
      cwd: config.cwd,
      goal,
      doneCriteria,
      permissionMode: config.permissionMode,
      mode: config.startMode ?? "autopilot",
      status: "idle",
      turns: 0,
      elapsedMin: 0,
      lastReply: "",
      lastDecision: "",
      stopRequested: false,
      canContinue: false,
      lastFire: Date.now(), // don't fire the schedule the instant it's created
    };
    this.sessions.set(id, m);
    this.store?.upsertSession(config);
    this.persist();
    return toView(m);
  }

  /** Edit a non-running session's config; persist. Throws if running. */
  updateSession(
    id: string,
    patch: Partial<{
      cwd: string;
      goal: string;
      doneCriteria: string;
      permissionMode: SessionConfig["permissionMode"];
      autonomy: SessionConfig["autonomy"];
      startMode: SessionConfig["startMode"];
      dependsOn: string[];
      schedule: SessionSchedule | null;
      autoPr: AutoPrConfig | null;
    }>,
  ): SessionView {
    const m = this.sessions.get(id);
    if (!m) throw new Error(`no session with id "${id}".`);
    validateSessionEnums(patch);

    // Edits apply LIVE: the brain reads m.config (goal / doneCriteria / autonomy)
    // by reference on its next decision. Only cwd + permissionMode are fixed at
    // launch — those can't change once the pty has spawned. A QUEUED session hasn't
    // launched yet, so it's still fully editable; reject only for active runs.
    const launched = ["running", "manual", "needs-input"].includes(m.status);
    if (launched) {
      if (patch.cwd !== undefined && path.resolve(patch.cwd.trim() || ".") !== m.config.cwd) {
        throw new Error("can't change the working directory while running — stop the session first.");
      }
      if (patch.permissionMode !== undefined && patch.permissionMode !== m.config.permissionMode) {
        throw new Error("permission mode is set when the session launches — stop and restart to change it.");
      }
    }

    if (patch.cwd !== undefined) {
      const cwd = patch.cwd.trim();
      if (!cwd) throw new Error("cwd cannot be empty.");
      m.config.cwd = path.resolve(cwd);
      m.cwd = m.config.cwd;
    }
    if (patch.goal !== undefined) {
      const goal = patch.goal.trim();
      if (!goal) throw new Error("goal cannot be empty.");
      m.config.goal = goal;
      m.goal = goal;
    }
    if (patch.doneCriteria !== undefined) {
      const doneCriteria = patch.doneCriteria.trim();
      if (!doneCriteria) throw new Error("doneCriteria cannot be empty.");
      m.config.doneCriteria = doneCriteria;
      m.doneCriteria = doneCriteria;
    }
    if (patch.permissionMode !== undefined) {
      m.config.permissionMode = patch.permissionMode;
      m.permissionMode = patch.permissionMode;
    }
    if (patch.autonomy !== undefined) m.config.autonomy = patch.autonomy;
    if (patch.startMode !== undefined) {
      m.config.startMode = patch.startMode;
      m.mode = patch.startMode;
    }
    if (patch.dependsOn !== undefined) {
      const dependsOn = this.normalizeDeps(id, patch.dependsOn);
      if (dependsOn.length) m.config.dependsOn = dependsOn;
      else delete m.config.dependsOn;
      // If the session is parked as blocked, re-evaluate against the new edges.
      if (m.status === "blocked") {
        const unmet = this.unmetDeps(m);
        m.blockedBy = unmet.length ? unmet : undefined;
        if (!unmet.length) {
          m.status = "idle";
          m.lastDecision = "";
        }
      }
    }
    if (patch.schedule !== undefined) {
      const schedule = patch.schedule === null ? undefined : normalizeSchedule(patch.schedule);
      if (schedule) m.config.schedule = schedule;
      else delete m.config.schedule;
      // Reset the schedule clock so an edit doesn't fire instantly on the next tick.
      m.lastFire = Date.now();
    }
    if (patch.autoPr !== undefined) {
      const autoPr = patch.autoPr === null ? undefined : normalizeAutoPr(patch.autoPr);
      if (autoPr) m.config.autoPr = autoPr;
      else delete m.config.autoPr;
    }
    this.store?.upsertSession(m.config);
    this.persist();
    return toView(m);
  }

  /** Delete a non-running session; persist. Throws if running. */
  removeSession(id: string): void {
    const m = this.sessions.get(id);
    if (!m) throw new Error(`no session with id "${id}".`);
    if (m.status === "running") throw new Error("stop the session before deleting it.");
    this.clearResumeTimer(id); // don't let a pending auto-resume fire for a removed session
    this.sessions.delete(id);
    this.persist();
  }

  /** Rebuild cfg.sessions from the live records and write config.json. */
  private persist(): void {
    this.cfg.sessions = [...this.sessions.values()].map((m) => m.config);
    void saveConfig(this.cfg).catch((e) => {
      console.error("⚠ failed to persist config:", e instanceof Error ? e.message : e);
    });
  }

  stop(id: string): void {
    const m = this.sessions.get(id);
    if (!m) return;
    // Cancel any pending auto-resume — an operator stop must stick.
    this.clearResumeTimer(id);
    // Paused on a real subscription limit: cancel the resume and mark it stopped.
    if (m.status === "rate-limited") {
      m.status = "stopped";
      m.lastDecision = "stopped by operator";
      return;
    }
    // Parked waiting for manual input: unblock the loop with a stop.
    if (m.resolveUserInput) {
      m.stopRequested = true;
      const resolve = m.resolveUserInput;
      m.resolveUserInput = undefined;
      resolve({ kind: "stop" });
      return;
    }
    // Queued but not yet running: just remove it from the queue.
    if (m.status === "queued") {
      const i = this.queue.indexOf(id);
      if (i >= 0) this.queue.splice(i, 1);
      m.status = "idle";
      m.lastDecision = "";
      return;
    }
    // Paused on a dangerous gate: deny it and stop the run.
    if (m.status === "needs-input" && m.resolveGate) {
      m.stopRequested = true;
      m.resolveGate({ kind: "deny" });
      return;
    }
    // Paused on a brain decision: unblock it with a stop resolution.
    if (m.status === "needs-input" && m.resolveAttention) {
      m.stopRequested = true;
      m.resolveAttention({ kind: "stop" });
      return;
    }
    // Running, or auto-paused on an unreachable brain (the loop is alive, polling
    // health): request stop; the wait loop sees it and ends the run.
    if (m.status !== "running" && m.status !== "paused") return;
    m.stopRequested = true;
    // Force-interrupt a long in-flight turn by tearing down the pty.
    void m.sess?.dispose();
  }

  async shutdown(): Promise<void> {
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    for (const id of [...this.resumeTimers.keys()]) this.clearResumeTimer(id);
    await Promise.allSettled(
      [...this.sessions.values()].map(async (m) => {
        m.stopRequested = true;
        await m.sess?.dispose();
      }),
    );
  }

  private onEvent(m: Managed, e: OrchestratorEvent): void {
    switch (e.type) {
      case "turn":
        m.turns = e.turnNumber;
        m.lastReply = e.result.assistantText;
        break;
      case "decision":
        m.lastDecision =
          e.decision.action === "stop"
            ? `STOP — ${e.decision.reason}`
            : e.decision.action === "escalate"
              ? `NEEDS YOU — ${e.decision.question ?? e.decision.reason}`
              : `→ ${e.decision.prompt} (${e.decision.reason})`;
        // A fresh decision is unrated — clear any thumb carried from the last one.
        m.lastDecisionFeedback = undefined;
        break;
      case "attention_resolved":
        m.lastDecision =
          e.resolution.kind === "stop"
            ? `you chose: stop`
            : `you chose: ${e.resolution.label}`;
        break;
      case "gate":
        m.lastDecision = `⚠ risky gate: ${e.request.summary}`;
        break;
      case "gate_resolved":
        m.lastDecision = `gate ${e.resolution.kind === "approve" ? "approved" : "denied"}: ${e.request.summary}`;
        break;
      case "rate_limited":
        m.status = "rate-limited";
        m.error = e.detail;
        this.notify(m, "rate-limited", e.detail);
        this.log.warn("rate limited", { session: m.id, detail: e.detail });
        break;
      case "usage":
        m.usage = e.status;
        this.lastUsage = e.status;
        break;
      case "limited": {
        // A real subscription limit is spent — pause and ALWAYS schedule a wakeup.
        m.status = "rate-limited";
        const known = !!e.resumeAt && e.resumeAt > Date.now();
        const at = known ? new Date(e.resumeAt!).toLocaleString() : "soon (re-checking)";
        m.error = `${e.reason} — auto-resumes at ${at}`;
        m.lastDecision = e.sonnetOnly ? `paused (Sonnet pool) — ${e.reason}` : `limit reached — ${e.reason}`;
        // If the reset time is unknown or already past (parse failure / stale read),
        // fall back to a periodic re-check so a paused session is NEVER wedged forever.
        const delay = known
          ? Math.min(e.resumeAt! - Date.now() + 5_000, 8 * 24 * 60 * 60_000)
          : 5 * 60_000;
        this.scheduleResume(m.id, delay);
        this.notify(m, "rate-limited", e.reason);
        this.log.warn("subscription limit", { session: m.id, reason: e.reason, resumeAt: at, sonnetOnly: !!e.sonnetOnly });
        break;
      }
      case "context":
        m.lastDecision =
          e.phase === "compacting"
            ? `compacting context (~${e.usedPercent}% used) — saving handoff…`
            : `resumed after compaction (was ~${e.usedPercent}%)`;
        break;
      case "brain":
        if (e.phase === "unreachable") {
          m.status = "paused";
          m.error = "local model unreachable — auto-resumes when it's back";
          m.lastDecision = `paused — local model unreachable${e.detail ? ` (${e.detail.slice(0, 80)})` : ""}`;
          this.log.warn("brain unreachable", { session: m.id, detail: e.detail });
        } else {
          // recovered: the loop resumes on its own; clear the pause.
          if (m.status === "paused") m.status = "running";
          m.error = undefined;
          m.lastDecision = "local model recovered — resuming";
          this.log.info("brain recovered", { session: m.id });
        }
        break;
      case "stop":
        // Don't clobber a rate-limited status with the stop that follows it.
        if (m.status !== "rate-limited") {
          m.status = m.stopRequested ? "stopped" : "done";
          m.lastDecision = `stopped: ${e.reason}`;
        }
        m.turns = e.turns;
        m.elapsedMin = e.elapsedMin;
        break;
      case "error":
        // A torn-down pty during an operator stop surfaces as an error; treat as stopped.
        m.status = m.stopRequested ? "stopped" : "error";
        if (!m.stopRequested) {
          m.error = e.error;
          this.log.error("orchestrator error", { session: m.id, error: e.error });
        }
        break;
    }
  }
}

function toView(m: Managed): SessionView {
  const active = ["running", "queued", "needs-input", "manual", "paused"].includes(m.status);
  return {
    id: m.id,
    cwd: m.cwd,
    goal: m.goal,
    doneCriteria: m.doneCriteria,
    permissionMode: m.permissionMode,
    autonomy: m.config.autonomy,
    mode: m.mode,
    status: m.status,
    turns: m.turns,
    elapsedMin: m.elapsedMin,
    lastReply: m.lastReply,
    lastDecision: m.lastDecision,
    lastDecisionFeedback: m.lastDecisionFeedback,
    error: m.error,
    attention: m.attention ?? null,
    canContinue: !active && !!(m.claudeSessionId ?? m.config.lastClaudeSessionId),
    dependsOn: m.config.dependsOn?.length ? m.config.dependsOn : undefined,
    blockedBy: m.blockedBy?.length ? m.blockedBy : undefined,
    schedule: m.config.schedule,
    autoPr: m.config.autoPr,
    prUrl: m.prUrl,
    prState: m.prState,
  };
}

/** Short human label for a session in dependency messages (goal head, else id). */
function shortLabel(m: Managed | undefined): string {
  if (!m) return "(unknown)";
  const g = m.goal.trim().replace(/\s+/g, " ");
  return g.length > 40 ? g.slice(0, 40) + "…" : g || m.id.slice(0, 8);
}

/**
 * Sanitize a proposed schedule: keep a positive integer everyMinutes and a valid
 * "HH:MM" dailyAt; return undefined when neither trigger is usable (so an empty
 * schedule is simply dropped rather than stored as dead config).
 */
function normalizeSchedule(s: SessionSchedule | undefined): SessionSchedule | undefined {
  if (!s) return undefined;
  const out: SessionSchedule = {};
  if (typeof s.everyMinutes === "number" && Number.isFinite(s.everyMinutes) && s.everyMinutes >= 1) {
    out.everyMinutes = Math.floor(s.everyMinutes);
  }
  const hhmm = parseHHMM(s.dailyAt);
  if (hhmm) {
    out.dailyAt = `${String(hhmm.h).padStart(2, "0")}:${String(hhmm.m).padStart(2, "0")}`;
  }
  if (out.everyMinutes === undefined && out.dailyAt === undefined) return undefined;
  out.enabled = s.enabled !== false;
  return out;
}

/**
 * Sanitize a proposed auto-PR setting: keep only a valid mode and a clean base
 * branch; undefined (or an unknown mode) disables it rather than storing junk.
 */
function normalizeAutoPr(a: AutoPrConfig | undefined | null): AutoPrConfig | undefined {
  if (!a || (a.mode !== "draft" && a.mode !== "ready")) return undefined;
  const out: AutoPrConfig = { mode: a.mode };
  const base = typeof a.base === "string" ? a.base.trim() : "";
  // A branch ref can't contain spaces or most punctuation; keep it conservative.
  if (base && /^[\w./-]+$/.test(base)) out.base = base;
  return out;
}

// Enum whitelists for client-supplied config fields. These flow into the pty
// spawn (permissionMode → `--permission-mode`) and the brain persona, so an
// out-of-range value must be rejected, not silently passed through.
const PERMISSION_MODES: ReadonlyArray<NonNullable<SessionConfig["permissionMode"]>> = [
  "default", "acceptEdits", "auto", "bypassPermissions",
];
const AUTONOMIES: ReadonlyArray<NonNullable<SessionConfig["autonomy"]>> = [
  "cautious", "balanced", "autonomous",
];
const START_MODES: ReadonlyArray<NonNullable<SessionConfig["startMode"]>> = ["manual", "autopilot"];

/** Throw a clear error if a provided enum value isn't in its whitelist (undefined is allowed). */
function assertEnum<T extends string>(
  label: string,
  value: T | undefined,
  allowed: ReadonlyArray<T>,
): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")} (got "${String(value)}").`);
  }
}

/** Validate the client-supplied enum fields shared by add/update. Throws on a bad value. */
function validateSessionEnums(input: {
  permissionMode?: SessionConfig["permissionMode"];
  autonomy?: SessionConfig["autonomy"];
  startMode?: SessionConfig["startMode"];
}): void {
  assertEnum("permissionMode", input.permissionMode, PERMISSION_MODES);
  assertEnum("autonomy", input.autonomy, AUTONOMIES);
  assertEnum("startMode", input.startMode, START_MODES);
}
