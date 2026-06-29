/**
 * Supervisor — manages all sessions for the dashboard. Holds a live record per
 * configured session (status, turns, last reply, last decision) updated from the
 * orchestrator event stream, plus a handle to the live ClaudeSession so the
 * dashboard can stream its screen and stop it.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runSession, type OrchestratorEvent, type RunOptions } from "../orchestrator.js";
import { ClaudeSession } from "../session/claudeSession.js";
import { LocalLLM } from "../brain/provider.js";
import { saveConfig } from "../config.js";
import { Recorder } from "../db/recorder.js";
import { BudgetTracker, type BudgetStatus } from "../policy/budget.js";
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
  | "needs-input"
  | "rate-limited"
  | "stopped"
  | "done"
  | "error";

export interface SessionView {
  id: string;
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode: SessionConfig["permissionMode"];
  status: SessionStatus;
  turns: number;
  elapsedMin: number;
  lastReply: string;
  lastDecision: string;
  error?: string;
  /** Present only while status === "needs-input": the open human decision. */
  attention?: AttentionRequest | null;
}

interface Managed extends SessionView {
  config: SessionConfig;
  sess?: ClaudeSession;
  stopRequested: boolean;
  /** Resolver for the open AttentionRequest's pending promise (if any). */
  resolveAttention?: (r: Resolution) => void;
  /** Resolver for an open dangerous-gate approval (if any). */
  resolveGate?: (r: GateResolution) => void;
  /** Wall-clock start of the current run (for live minute accounting). */
  startedAt?: number;
}

export class Supervisor {
  private readonly sessions = new Map<string, Managed>();
  private readonly llm: LocalLLM;
  private readonly recorder?: Recorder;
  private readonly budget: BudgetTracker;
  private readonly running = new Set<string>();
  private readonly queue: string[] = [];
  private readonly maxConcurrent: number;

  constructor(
    private readonly cfg: AppConfig,
    private readonly store?: Store,
    /** Optional brain override (e.g. a faster model, or a test stub). */
    private readonly decide?: RunOptions["decide"],
    /** Optional session-runner override (defaults to the real orchestrator). */
    private readonly runner: RunFn = runSession,
  ) {
    this.llm = new LocalLLM(cfg.provider);
    this.budget = new BudgetTracker(store, cfg.budget);
    this.maxConcurrent = cfg.maxConcurrent && cfg.maxConcurrent > 0 ? cfg.maxConcurrent : Infinity;
    if (store) this.recorder = new Recorder(store);
    for (const s of cfg.sessions) {
      this.sessions.set(s.id, {
        config: s,
        id: s.id,
        cwd: s.cwd,
        goal: s.goal,
        doneCriteria: s.doneCriteria,
        permissionMode: s.permissionMode,
        status: "idle",
        turns: 0,
        elapsedMin: 0,
        lastReply: "",
        lastDecision: "",
        stopRequested: false,
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
      if (m.status === "running" || m.status === "needs-input") {
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

  /** Request a session to run: launch now if a slot is free, else queue it. */
  start(id: string): void {
    const m = this.sessions.get(id);
    if (!m || m.status === "running" || m.status === "queued" || m.status === "needs-input") return;
    const b = this.budgetStatus();
    if (b.exceeded) {
      m.lastDecision = `blocked — ${b.reason}`;
      return; // refuse to start: daily budget spent
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
    m.startedAt = Date.now();

    void this.runner(m.config, {
      llm: this.llm,
      limits: this.cfg.limits,
      decide: this.decide,
      onSession: (s) => (m.sess = s),
      // Stop on operator request OR when the daily budget is spent (with a reason).
      shouldStop: () => {
        if (m.stopRequested) return true;
        const b = this.budgetStatus();
        return b.exceeded ? b.reason : false;
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

  /** Create a new session, add it to the live map as "idle", and persist. */
  addSession(input: {
    id?: string;
    cwd: string;
    goal: string;
    doneCriteria: string;
    permissionMode?: SessionConfig["permissionMode"];
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
    };
    const m: Managed = {
      config,
      id,
      cwd: config.cwd,
      goal,
      doneCriteria,
      permissionMode: config.permissionMode,
      status: "idle",
      turns: 0,
      elapsedMin: 0,
      lastReply: "",
      lastDecision: "",
      stopRequested: false,
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
    }>,
  ): SessionView {
    const m = this.sessions.get(id);
    if (!m) throw new Error(`no session with id "${id}".`);
    if (m.status === "running") throw new Error("stop the session before editing it.");

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
    this.store?.upsertSession(m.config);
    this.persist();
    return toView(m);
  }

  /** Delete a non-running session; persist. Throws if running. */
  removeSession(id: string): void {
    const m = this.sessions.get(id);
    if (!m) throw new Error(`no session with id "${id}".`);
    if (m.status === "running") throw new Error("stop the session before deleting it.");
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
  return {
    id: m.id,
    cwd: m.cwd,
    goal: m.goal,
    doneCriteria: m.doneCriteria,
    permissionMode: m.permissionMode,
    status: m.status,
    turns: m.turns,
    elapsedMin: m.elapsedMin,
    lastReply: m.lastReply,
    lastDecision: m.lastDecision,
    error: m.error,
    attention: m.attention ?? null,
  };
}
