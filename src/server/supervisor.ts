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
import { LearningService, emptyLearningSummary } from "../learning/service.js";
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
  GateResolution,
  Resolution,
  SessionConfig,
} from "../types.js";

/** The session-runner the supervisor drives (real one is runSession; tests inject a stub). */
export type RunFn = (session: SessionConfig, opts: RunOptions) => Promise<void>;

export type SessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "manual" // active but waiting for the user to drive (Qwen paused)
  | "needs-input"
  | "rate-limited"
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
  error?: string;
  /** Present only while status === "needs-input": the open human decision. */
  attention?: AttentionRequest | null;
  /** True when the session has run before (so it can be CONTINUED, not just started). */
  canContinue: boolean;
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

  constructor(
    private readonly cfg: AppConfig,
    private readonly store?: Store,
    /** Optional brain override (e.g. a faster model, or a test stub). */
    private readonly decide?: RunOptions["decide"],
    /** Optional session-runner override (defaults to the real orchestrator). */
    private readonly runner: RunFn = runSession,
  ) {
    this.llm = new LocalLLM(cfg.provider);
    if (cfg.escalationProvider) this.heavyLlm = new LocalLLM(cfg.escalationProvider);
    this.budget = new BudgetTracker(store, cfg.budget);
    this.usageGuard = new UsageGuard(cfg.usageGuard);
    this.maxConcurrent = cfg.maxConcurrent && cfg.maxConcurrent > 0 ? cfg.maxConcurrent : Infinity;
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
      });
      this.store?.upsertSession(s);
    }
  }

  health() {
    return this.llm.health();
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map(toView);
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
      if (m.status === "running" || m.status === "needs-input" || m.status === "manual") {
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

  /** Request a session to run: launch now if a slot is free, else queue it. */
  start(id: string): void {
    const m = this.sessions.get(id);
    if (!m || ["running", "queued", "needs-input", "manual"].includes(m.status)) return;
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
    if (["running", "queued", "needs-input", "manual"].includes(m.status)) {
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
  }): SessionView {
    const cwd = (input.cwd ?? "").trim();
    const goal = (input.goal ?? "").trim();
    const doneCriteria = (input.doneCriteria ?? "").trim();
    if (!cwd) throw new Error("cwd is required.");
    if (!goal) throw new Error("goal is required.");
    if (!doneCriteria) throw new Error("doneCriteria is required.");

    const id = (input.id ?? "").trim() || randomUUID();
    if (this.sessions.has(id)) throw new Error(`a session with id "${id}" already exists.`);

    const config: SessionConfig = {
      id,
      cwd: path.resolve(cwd),
      goal,
      doneCriteria,
      permissionMode: input.permissionMode ?? "acceptEdits",
      autonomy: input.autonomy ?? "balanced",
      startMode: input.startMode ?? "autopilot",
      resumeId: input.resumeId,
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
    }>,
  ): SessionView {
    const m = this.sessions.get(id);
    if (!m) throw new Error(`no session with id "${id}".`);

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
    if (m.status !== "running") return;
    m.stopRequested = true;
    // Force-interrupt a long in-flight turn by tearing down the pty.
    void m.sess?.dispose();
  }

  async shutdown(): Promise<void> {
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
        break;
      }
      case "context":
        m.lastDecision =
          e.phase === "compacting"
            ? `compacting context (~${e.usedPercent}% used) — saving handoff…`
            : `resumed after compaction (was ~${e.usedPercent}%)`;
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
        if (!m.stopRequested) m.error = e.error;
        break;
    }
  }
}

function toView(m: Managed): SessionView {
  const active = ["running", "queued", "needs-input", "manual"].includes(m.status);
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
    error: m.error,
    attention: m.attention ?? null,
    canContinue: !active && !!(m.claudeSessionId ?? m.config.lastClaudeSessionId),
  };
}
