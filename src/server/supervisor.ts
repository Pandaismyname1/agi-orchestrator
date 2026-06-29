/**
 * Supervisor — manages all sessions for the dashboard. Holds a live record per
 * configured session (status, turns, last reply, last decision) updated from the
 * orchestrator event stream, plus a handle to the live ClaudeSession so the
 * dashboard can stream its screen and stop it.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runSession, type OrchestratorEvent } from "../orchestrator.js";
import { ClaudeSession } from "../session/claudeSession.js";
import { LocalLLM } from "../brain/provider.js";
import { saveConfig } from "../config.js";
import { Recorder } from "../db/recorder.js";
import type { Store } from "../db/store.js";
import type { AppConfig, SessionConfig } from "../types.js";

export type SessionStatus = "idle" | "running" | "stopped" | "done" | "error";

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
}

interface Managed extends SessionView {
  config: SessionConfig;
  sess?: ClaudeSession;
  stopRequested: boolean;
}

export class Supervisor {
  private readonly sessions = new Map<string, Managed>();
  private readonly llm: LocalLLM;
  private readonly recorder?: Recorder;

  constructor(
    private readonly cfg: AppConfig,
    private readonly store?: Store,
  ) {
    this.llm = new LocalLLM(cfg.provider);
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

  start(id: string): void {
    const m = this.sessions.get(id);
    if (!m || m.status === "running") return;
    m.status = "running";
    m.stopRequested = false;
    m.error = undefined;
    m.turns = 0;
    m.lastReply = "";
    m.lastDecision = "";

    void runSession(m.config, {
      llm: this.llm,
      limits: this.cfg.limits,
      onSession: (s) => (m.sess = s),
      shouldStop: () => m.stopRequested,
      onEvent: (e) => {
        this.onEvent(m, e);
        this.recorder?.record(e);
      },
    }).then(() => {
      // If the loop ended without an explicit stop/error event, mark done.
      if (m.status === "running") m.status = "done";
      m.sess = undefined;
    });
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
    if (!m || m.status !== "running") return;
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
            : `→ ${e.decision.prompt} (${e.decision.reason})`;
        break;
      case "stop":
        m.status = m.stopRequested ? "stopped" : "done";
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
  };
}
