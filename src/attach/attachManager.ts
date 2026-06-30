/**
 * AttachManager — hook-attach mode.
 *
 * Drives a `claude` session the USER started by hand (NOT daemon-owned). The
 * mechanism: a Stop hook registered in the user's Claude settings fires when
 * claude finishes a turn and POSTs to our daemon's `/hook` route. The daemon
 * calls `handle()` here; we read the last assistant message, run per-session
 * guards (turns / wall-clock / ping-pong), ask the brain for the next step, and
 * return a decision. The hook then injects `{decision:"block", reason:<prompt>}`
 * to make claude continue — or lets it stop.
 *
 * This class is FULLY DECOUPLED via injected dependencies (`brain`,
 * `readLastMessage`). It does not import the brain or the transcript reader
 * directly, so it can be unit-tested with stubs and with no network / no claude.
 * See INTEGRATION.md for how to wire the real deps and the `/hook` route.
 */
import { Guards } from "../policy/guards.js";

/** What the injected brain must accept and return (a minimal local shape). */
export interface AttachBrainInput {
  goal: string;
  doneCriteria: string;
  lastAssistantText: string;
  turnNumber: number;
}

export interface AttachBrainResult {
  action: "continue" | "stop";
  /** Next prompt to inject when action === "continue". */
  prompt?: string;
  reason: string;
  /**
   * True when the brain actually wants a HUMAN decision (an escalation). The
   * hand-driven session still stops (we can't pause someone else's terminal), but
   * we flag it so the dashboard can show "needs you" on the attached session.
   */
  needsInput?: boolean;
}

/** Injected dependency: ask the brain what to do next, as the user's stand-in. */
export type AttachBrain = (input: AttachBrainInput) => Promise<AttachBrainResult>;

/** Injected dependency: read claude's last assistant message from its transcript. */
export type ReadLastMessage = (cwd: string, sessionId: string) => Promise<string>;

/** A dashboard-facing view of one attached, hand-started session. */
export interface AttachedView {
  sessionId: string;
  goal: string;
  doneCriteria: string;
  /** Number of continue decisions injected so far (turns we've driven). */
  turns: number;
  /** Epoch ms the session was registered. */
  registeredAt: number;
  /** Epoch ms the Stop hook last fired for this session (undefined until first turn). */
  lastActivity?: number;
  /** Last decision we returned ("continue" | "stop"). */
  lastAction?: "continue" | "stop";
  /** Reason text for the last decision. */
  lastReason?: string;
  /** True when the brain escalated — a human decision is wanted (can't auto-resolve). */
  needsInput?: boolean;
}

/** Guard limits for an attached session. Mirrors the shape `Guards` needs. */
export interface AttachLimits {
  maxTurns: number;
  maxWallClockMin: number;
  pingPongThreshold: number;
}

export interface AttachManagerDeps {
  brain: AttachBrain;
  readLastMessage: ReadLastMessage;
  limits: AttachLimits;
  /** Clock, injectable for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/** The body the Stop hook POSTs to `/hook` (a subset of Claude's hook payload). */
export interface HookBody {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  stop_hook_active?: boolean;
}

/** The decision returned to the hook (and serialized as the HTTP response). */
export interface HookDecision {
  action: "continue" | "stop";
  prompt: string | null;
  reason: string;
}

interface AttachedSession {
  goal: string;
  doneCriteria: string;
  guards: Guards;
  registeredAt: number;
  turns: number;
  lastActivity?: number;
  lastAction?: "continue" | "stop";
  lastReason?: string;
  needsInput?: boolean;
}

export class AttachManager {
  private readonly brain: AttachBrain;
  private readonly readLastMessage: ReadLastMessage;
  private readonly limits: AttachLimits;
  private readonly now: () => number;
  private readonly sessions = new Map<string, AttachedSession>();

  constructor(deps: AttachManagerDeps) {
    this.brain = deps.brain;
    this.readLastMessage = deps.readLastMessage;
    this.limits = deps.limits;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Record an attached session and create a fresh guard tracker for it. Call
   * this before the user's session starts firing Stop hooks (e.g. from a
   * dashboard action or config). Re-registering resets the guards.
   */
  register(sessionId: string, cfg: { goal: string; doneCriteria: string }): void {
    this.sessions.set(sessionId, {
      goal: cfg.goal,
      doneCriteria: cfg.doneCriteria,
      // Guards wants a full Limits; our AttachLimits is structurally identical.
      guards: new Guards(this.limits),
      registeredAt: this.now(),
      turns: 0,
    });
  }

  /** Forget an attached session (e.g. when the user detaches it). */
  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** True if the session id is currently attached. */
  isRegistered(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Dashboard view of every attached session, newest-registered first. */
  list(): AttachedView[] {
    return [...this.sessions.entries()]
      .map(([sessionId, s]) => ({
        sessionId,
        goal: s.goal,
        doneCriteria: s.doneCriteria,
        turns: s.turns,
        registeredAt: s.registeredAt,
        lastActivity: s.lastActivity,
        lastAction: s.lastAction,
        lastReason: s.lastReason,
        needsInput: s.needsInput,
      }))
      .sort((a, b) => b.registeredAt - a.registeredAt);
  }

  /**
   * Core: decide what an attached session should do when its turn ends.
   * Never throws — any error maps to a safe `stop`.
   */
  async handle(body: HookBody): Promise<HookDecision> {
    try {
      // Loop guard: claude sets stop_hook_active when it's already continuing
      // because of a previous block decision. Honor it to avoid infinite loops.
      if (body.stop_hook_active) {
        return { action: "stop", prompt: null, reason: "stop_hook_active (loop guard)" };
      }

      const sessionId = body.session_id;
      const sess = this.sessions.get(sessionId);
      if (!sess) {
        return {
          action: "stop",
          prompt: null,
          reason: `session ${sessionId} is not attached`,
        };
      }

      // Every hook firing for an attached session counts as activity, whatever
      // we end up deciding — record it so the dashboard shows a live heartbeat.
      sess.lastActivity = this.now();

      // Record the final decision on the session (drives the dashboard view),
      // then return it. A "continue" also advances the driven-turn counter.
      const record = (d: HookDecision, needsInput = false): HookDecision => {
        sess.lastAction = d.action;
        sess.lastReason = d.reason;
        sess.needsInput = needsInput;
        if (d.action === "continue") sess.turns += 1;
        return d;
      };

      const lastAssistantText = await this.readLastMessage(body.cwd, sessionId);

      // Brain decides FIRST so we know the candidate next prompt, then the
      // guard checks that prompt (turns / time / ping-pong) before we allow it.
      const decision = await this.brain({
        goal: sess.goal,
        doneCriteria: sess.doneCriteria,
        lastAssistantText,
        turnNumber: sess.guards.turnCount + 1,
      });

      if (decision.action === "stop") {
        return record(
          {
            action: "stop",
            prompt: null,
            reason: decision.reason || "brain decided to stop",
          },
          !!decision.needsInput,
        );
      }

      const prompt = (decision.prompt ?? "").trim();
      if (!prompt) {
        return record({
          action: "stop",
          prompt: null,
          reason: "brain said continue but gave no prompt",
        });
      }

      const guard = sess.guards.check(prompt);
      if (guard.stop) {
        return record({ action: "stop", prompt: null, reason: guard.reason });
      }

      return record({ action: "continue", prompt, reason: decision.reason || "continuing" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { action: "stop", prompt: null, reason: `attach handler error: ${msg}` };
    }
  }
}
