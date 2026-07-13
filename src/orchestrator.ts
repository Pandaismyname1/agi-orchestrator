/**
 * The autopilot loop for one session:
 *
 *   inject goal -> claude works -> turn ends -> read reply
 *     -> local brain decides next step (or STOP)
 *       -> guards check (turns / time / ping-pong)
 *         -> inject next step -> repeat
 *
 * This is the whole point of the project: the brain stands in for the human so
 * claude never sits idle waiting for you to answer "ok, continue".
 */
import { ClaudeSession, AuthError, RateLimitError, CwdError, TimeoutError } from "./session/claudeSession.js";
import { decideNextStep } from "./brain/decide.js";
import { triageScreen } from "./brain/triage.js";
import {
  readRecentMessages,
  readLastAssistantMessage,
  transcriptStat,
  transcriptTurnEnded,
  assistantTextAfterOffset,
} from "./transcript/reader.js";

/** Thrown inside turn recovery when the operator stopped the run mid-recovery. */
class StopRequested extends Error {
  constructor() {
    super("stopped by operator");
  }
}
import { gitSummary } from "./brain/repoState.js";
import { RollingSummary, type RollingSummaryOptions } from "./brain/summary.js";
import { LocalLLM, isTransientError } from "./brain/provider.js";
import { Guards } from "./policy/guards.js";
import { StuckDetector, fingerprintDir } from "./policy/stuck.js";
import { isGitRepo, snapshotRef, turnDiff, protectSnapshot } from "./git/diff.js";
import type { ContextGuard } from "./policy/context.js";
import type { UsageGuard } from "./policy/usage.js";
import type { UsageStatus } from "./policy/usage.js";
import { randomUUID } from "node:crypto";
import type {
  AttentionRequest,
  Decision,
  GateRequest,
  GateResolution,
  Limits,
  Resolution,
  SessionConfig,
  TurnResult,
} from "./types.js";

export type OrchestratorEvent =
  | { type: "start"; sessionId: string; goal: string }
  | { type: "turn"; sessionId: string; turnNumber: number; result: TurnResult }
  | { type: "decision"; sessionId: string; turnNumber: number; decision: Decision }
  | { type: "attention"; sessionId: string; turnNumber: number; request: AttentionRequest }
  | { type: "attention_resolved"; sessionId: string; request: AttentionRequest; resolution: Resolution }
  | { type: "gate"; sessionId: string; request: GateRequest }
  | { type: "gate_resolved"; sessionId: string; request: GateRequest; resolution: GateResolution }
  | { type: "rate_limited"; sessionId: string; detail: string }
  /** A fresh read of Claude's real /usage limits. */
  | { type: "usage"; sessionId: string; status: UsageStatus }
  /** A real subscription limit is spent; the session pauses until resumeAt (if known). */
  | { type: "limited"; sessionId: string; reason: string; resumeAt?: number; sonnetOnly: boolean }
  | { type: "stop"; sessionId: string; reason: string; turns: number; elapsedMin: number }
  | { type: "context"; sessionId: string; phase: "compacting" | "resumed"; usedPercent: number }
  /** The local brain (LLM) went unreachable and the run auto-paused, or recovered. */
  | { type: "brain"; sessionId: string; phase: "unreachable" | "recovered"; detail?: string }
  /** A dead/frozen turn was self-healed by respawning claude and resuming the conversation. */
  | { type: "recovery"; sessionId: string; turnNumber: number; attempt: number; detail: string }
  | { type: "error"; sessionId: string; error: string };

export type EventSink = (e: OrchestratorEvent) => void;

/**
 * What the autopilot loop needs from a session driver. ClaudeSession (the PTY
 * engine) satisfies it as-is; HeadlessClaudeSession (`claude -p`) implements it
 * without a TUI. Structural — no inheritance required.
 */
export interface AgentSession {
  readonly sessionId: string;
  /**
   * Whether the memory-preserving /compact flow works for this driver. Undefined
   * = true (the PTY engine). The headless engine sets false: it can't read
   * /context and a "/compact" prompt through `claude -p` is not the panel flow.
   */
  readonly supportsCompaction?: boolean;
  onGate?: (req: GateRequest) => Promise<GateResolution>;
  onTriage?: (screenText: string) => Promise<import("./session/claudeSession.js").ScreenTriage | null>;
  start(): Promise<void>;
  runTurn(prompt: string): Promise<TurnResult>;
  readUsage(): Promise<UsageStatus | undefined>;
  readContextFraction(): Promise<number | null>;
  screenText(): string;
  state(): import("./types.js").ScreenState;
  readonly isAlive: boolean;
  dispose(): Promise<void>;
}

/** What the user does while a session is in MANUAL mode. */
export type UserInput =
  | { kind: "message"; text: string } // type a message straight to the agent
  | { kind: "switch" } // flip to autopilot — hand the wheel to Qwen
  | { kind: "stop" };

export interface RunOptions {
  llm: LocalLLM;
  limits: Limits;
  onEvent?: EventSink;
  /** Hands the live session to the caller (for dashboard screen reads + stop). */
  onSession?: (sess: AgentSession) => void;
  /**
   * Session-driver factory. Defaults to the PTY ClaudeSession; the runner passes
   * a HeadlessClaudeSession factory for `engine: "claude-headless"` sessions.
   * Turn recovery calls it again to respawn into the same conversation.
   */
  createSession?: (cfg: SessionConfig) => AgentSession;
  /**
   * Checked at the top of each loop iteration. Return true (or a reason string)
   * to stop gracefully; false/undefined to continue.
   */
  shouldStop?: () => boolean | string;
  /**
   * Called when the brain escalates a genuine decision to the human. Must block
   * until the human (or a policy) resolves it, returning the chosen prompt or a
   * stop. If omitted, an escalation safely stops the run (no one to ask).
   */
  resolveAttention?: (req: AttentionRequest) => Promise<Resolution>;
  /**
   * Called when a DANGEROUS gate (e.g. `rm -rf`, force-push) needs approval.
   * Must return approve/deny. If omitted, dangerous gates are default-denied.
   */
  resolveGate?: (req: GateRequest) => Promise<GateResolution>;
  /**
   * Override the brain decision function. Defaults to the real local-LLM
   * decideNextStep. Lets callers inject a faster/different model — or a stub for
   * deterministic tests.
   */
  decide?: (
    llm: LocalLLM,
    session: SessionConfig,
    lastAssistantText: string,
    turnNumber: number,
    history?: Array<{ role: "user" | "assistant"; text: string }>,
    repoState?: string,
    projectSummary?: string,
  ) => Promise<Decision>;
  /** Current mode, read each loop iteration. Default "autopilot" if omitted. */
  mode?: () => "manual" | "autopilot";
  /** In MANUAL mode, block until the user sends a message, switches, or stops. */
  waitForInput?: () => Promise<UserInput>;
  /**
   * Proactively compact the conversation before its context window overflows
   * (save handoff → /compact → resume). Off unless a guard is supplied.
   */
  contextGuard?: ContextGuard;
  /**
   * Pause the session on Claude's REAL subscription limits (read from /usage) and
   * report them, instead of an artificial daily budget. Inert unless enabled.
   */
  usageGuard?: UsageGuard;
  /**
   * Resume an existing claude conversation by id (overrides session.resumeId).
   * Used to "continue" a finished session in the SAME conversation so its prior
   * context carries over.
   */
  resumeId?: string;
  /**
   * Inject this as the very first prompt of the run, before any brain/manual
   * sourcing — regardless of resume state. Used by "continue" to deliver the
   * (possibly edited) goal / next instruction into a resumed conversation.
   */
  seedPrompt?: string;
  /**
   * Feed the brain a maintained running summary (+ short fresh tail) instead of
   * the raw last-N history. Off unless enabled — then history shrinks to the tail.
   */
  rollingSummary?: RollingSummaryOptions;
  /**
   * Milliseconds between health polls while auto-paused on an unreachable brain
   * LLM. Default 15000. Lower = resumes sooner; higher = less load on the endpoint.
   */
  brainPollMs?: number;
}

export async function runSession(session: SessionConfig, opts: RunOptions): Promise<void> {
  const { llm, onEvent } = opts;
  const emit: EventSink = onEvent ?? (() => {});
  const limits: Limits = { ...opts.limits, ...(session.limits ?? {}) };
  const guards = new Guards(limits);
  const stuck = new StuckDetector();
  // Optional maintained running summary fed to the brain (else raw history).
  const summarizer = opts.rollingSummary?.enabled ? new RollingSummary(opts.rollingSummary) : undefined;
  // Build a wired session. Turn recovery may replace the live session with a
  // fresh one resuming the SAME conversation, so construction is reusable and
  // every consumer (gate handler, dashboard hook) is re-attached each time.
  const newDriver = opts.createSession ?? ((c: SessionConfig) => new ClaudeSession(c));
  const makeSession = (resumeId?: string): AgentSession => {
    const s = newDriver(resumeId ? { ...session, resumeId } : session);
    // Per-gate safety: a dangerous gate pauses here, is surfaced, and is resolved
    // by the human (resolveGate) or default-denied.
    s.onGate = async (req): Promise<GateResolution> => {
      emit({ type: "gate", sessionId: session.id, request: req });
      const resolution: GateResolution = opts.resolveGate
        ? await opts.resolveGate(req)
        : { kind: "deny" };
      emit({ type: "gate_resolved", sessionId: session.id, request: req, resolution });
      return resolution;
    };
    // Fallback perception: when the screen is frozen and unrecognized, the local
    // brain triages it (and may suggest one safe keystroke) before the session
    // gives up. Free (local model) and best-effort — errors return null.
    s.onTriage = (screenText) => triageScreen(llm, screenText);
    opts.onSession?.(s);
    return s;
  };
  // opts.resumeId (a "continue") takes precedence over the session's own resumeId.
  let sess = makeSession(opts.resumeId ?? session.resumeId);

  emit({ type: "start", sessionId: session.id, goal: session.goal });

  try {
    await sess.start();

    // ---- turn-level self-healing --------------------------------------------
    // A frozen/unrecognized screen or a crashed claude.exe used to kill the whole
    // run (the top killers in practice: 31x "exited (code 1)", ~10x frozen-screen).
    // Instead: respawn claude RESUMING the same conversation, check the transcript
    // to see whether the reply already landed (never double-execute a prompt), and
    // only re-inject if it didn't. Bounded attempts with backoff; auth/rate-limit/
    // cwd errors are never retried (they need the human or a pause, not a respawn).
    const MAX_TURN_RECOVERIES = 2;
    const RECOVERY_BACKOFF_MS = [5_000, 30_000];
    const isRecoverableTurnError = (e: unknown): boolean => {
      if (e instanceof AuthError || e instanceof RateLimitError || e instanceof CwdError) return false;
      if (e instanceof TimeoutError) return true;
      return e instanceof Error && (/claude exited \(code/.test(e.message) || e.message === "session not running");
    };
    // A prompt re-injected after PARTIAL execution must not blindly re-run —
    // side effects may already have happened. Wrap it so claude reconciles
    // against what's already done. Slash commands re-inject verbatim (they're
    // local commands; the wrapper text would break them).
    const reinjection = (p: string): string =>
      p.trim().startsWith("/")
        ? p
        : "Your previous instruction was interrupted mid-execution by a technical failure. " +
          "The instruction was:\n---\n" + p + "\n---\n" +
          "Check what has ALREADY been done (files on disk, repo state, your own prior messages) " +
          "and complete only the remainder — do not redo finished work.";
    const runTurnRecovered = async (prompt: string): Promise<TurnResult> => {
      const t0 = Date.now();
      const offset = (await transcriptStat(session.cwd, sess.sessionId))?.size ?? 0;
      let attemptPrompt = prompt;
      for (let attempt = 0; ; attempt++) {
        try {
          if (attempt > 0) {
            await sess.dispose();
            await sleep(RECOVERY_BACKOFF_MS[Math.min(attempt - 1, RECOVERY_BACKOFF_MS.length - 1)]!);
            if (opts.shouldStop?.()) {
              // The operator stopped during the backoff — do not resurrect the
              // session they killed; surface the stop to the outer loop.
              throw new StopRequested();
            }
            sess = makeSession(sess.sessionId); // resume the SAME conversation
            await sess.start();
            // Transcript triage: what actually happened to this turn before the
            // failure? (The transcript is ground truth; never re-run blindly.)
            const ts = await transcriptStat(session.cwd, sess.sessionId);
            const activity = !!ts && ts.size > offset;
            if (activity) {
              const ended = await transcriptTurnEnded(session.cwd, sess.sessionId);
              const landed = await assistantTextAfterOffset(session.cwd, sess.sessionId, offset);
              // Fully complete: final reply landed — the turn is done, return it.
              if (ended && landed !== null) {
                return { prompt, assistantText: landed, gatesHandled: 0, durationMs: Date.now() - t0 };
              }
              // Partial execution: work happened but no final reply. Give a
              // possibly-still-finishing turn a bounded grace window, then
              // reconcile-and-continue instead of double-executing.
              const graceUntil = Date.now() + 120_000;
              while (Date.now() < graceUntil) {
                await sleep(5_000);
                if (opts.shouldStop?.()) throw new StopRequested();
                const now = await transcriptStat(session.cwd, sess.sessionId);
                if (now && ts && now.size !== ts.size) break; // still moving — recheck below
                if (await transcriptTurnEnded(session.cwd, sess.sessionId)) {
                  const text = await assistantTextAfterOffset(session.cwd, sess.sessionId, offset);
                  if (text !== null) {
                    return { prompt, assistantText: text, gatesHandled: 0, durationMs: Date.now() - t0 };
                  }
                  break;
                }
              }
              attemptPrompt = reinjection(prompt);
            }
          }
          return await sess.runTurn(attemptPrompt);
        } catch (e) {
          if (e instanceof StopRequested) throw e;
          if (opts.shouldStop?.()) {
            // An operator stop tears the session down mid-turn, which surfaces
            // as "claude exited" — that is a STOP, not a failure to recover from.
            throw new StopRequested();
          }
          if (attempt >= MAX_TURN_RECOVERIES || !isRecoverableTurnError(e)) throw e;
          emit({
            type: "recovery",
            sessionId: session.id,
            turnNumber: guards.turnCount,
            attempt: attempt + 1,
            detail: (e as Error).message.slice(0, 200),
          });
        }
      }
    };

    const stopRun = (reason: string) =>
      emit({ type: "stop", sessionId: session.id, reason, turns: guards.turnCount, elapsedMin: guards.elapsedMin });

    const ug = opts.usageGuard;
    // Read Claude's REAL limits (/usage — a local command, no model usage) while
    // the session is idle and pause if a governing one is spent. Returns true
    // when it stopped the run, so callers can exit the loop.
    const checkUsage = async (): Promise<boolean> => {
      if (!ug?.enabled) return false;
      const status = await sess.readUsage();
      if (!status) return false;
      emit({ type: "usage", sessionId: session.id, status });
      const v = ug.verdict(status);
      if (v.blocked) {
        emit({ type: "limited", sessionId: session.id, reason: v.reason, resumeAt: v.resumeAt, sonnetOnly: v.sonnetOnly });
        stopRun(v.reason);
        return true;
      }
      return false;
    };

    // Auto-pause when the local brain (LLM) is unreachable (e.g. the model was
    // unloaded mid-run): wait + poll its health instead of killing the run, and
    // resume the moment it's back. Returns false only if the operator stopped.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const brainPollMs = opts.brainPollMs && opts.brainPollMs > 0 ? opts.brainPollMs : 15_000;
    const waitForBrain = async (detail: string): Promise<boolean> => {
      emit({ type: "brain", sessionId: session.id, phase: "unreachable", detail });
      for (;;) {
        if (opts.shouldStop?.()) return false;
        await sleep(brainPollMs);
        if (opts.shouldStop?.()) return false;
        const h = await llm.health();
        if (h.ok) {
          emit({ type: "brain", sessionId: session.id, phase: "recovered" });
          return true;
        }
      }
    };

    let pending: string | null = null; // the next prompt to inject, once sourced
    let lastResult: TurnResult | null = null;
    let seeded = false; // whether the opts.seedPrompt (continue) has been injected
    // Per-turn git snapshots (observability). Capture a baseline of the working
    // tree before the first turn; after each turn we snapshot again and store the
    // delta. Best-effort: a non-repo cwd or any git hiccup just skips diffs.
    const gitTracked = isGitRepo(session.cwd);
    let prevSnapshot = gitTracked ? snapshotRef(session.cwd) : null;
    let limited = await checkUsage(); // gate before the very first turn

    while (!limited) {
      const stopSignal = opts.shouldStop?.();
      if (stopSignal) {
        stopRun(typeof stopSignal === "string" ? stopSignal : "stopped by operator");
        break;
      }

      const mode = opts.mode?.() ?? "autopilot";

      // ---- source the next prompt, by mode -------------------------------
      if (pending === null) {
        if (!seeded && opts.seedPrompt) {
          // CONTINUE: deliver the edited goal / next instruction first, into the
          // resumed conversation, before normal brain/manual sourcing kicks in.
          pending = opts.seedPrompt;
          seeded = true;
        } else if (mode === "manual") {
          // MANUAL: Qwen stays silent — wait for the user to drive.
          const inp: UserInput = opts.waitForInput ? await opts.waitForInput() : { kind: "stop" };
          if (inp.kind === "stop") {
            stopRun("stopped by operator");
            break;
          }
          if (inp.kind === "switch") continue; // re-loop; mode is now autopilot
          pending = inp.text;
        } else {
          // AUTOPILOT: brain sources the next step.
          const lastText = lastResult?.assistantText ?? (await readLastAssistantMessage(session.cwd, sess.sessionId));
          if (lastResult === null && lastText === "" && session.goal) {
            // Fresh autopilot run, nothing seeded yet — kick off with the goal.
            pending = session.goal;
          } else {
            const history = await readRecentMessages(session.cwd, sess.sessionId, 8);
            // Git ground truth — lets the brain trust the disk over the agent's
            // claims. "" for a non-repo cwd (then the brain sees no REPO STATE).
            const repoState = await gitSummary(session.cwd);
            // Rolling summary (when enabled): fold recent steps forward and feed
            // {summary + short tail} instead of the full raw history.
            let projectSummary: string | undefined;
            let brainHistory = history;
            // The default maps our (…, history, repoState, projectSummary) contract onto
            // decideNextStep's (…, learnedGuidance, repoState, confidenceThreshold, projectSummary)
            // — no learned guidance / gate here; the supervisor's wrapper supplies those.
            const decide =
              opts.decide ??
              ((llm2, s, lt, tn, h, rs, ps) => decideNextStep(llm2, s, lt, tn, h, undefined, rs, undefined, ps));
            // The brain calls hit the LOCAL LLM. If it's unreachable (model
            // unloaded / server restarting) and survives the provider's own
            // retries, auto-pause and wait for it to return rather than ending
            // the run; the operator can still stop while paused.
            let decision: Decision;
            try {
              if (summarizer) {
                await summarizer.maybeUpdate(llm, guards.turnCount, history);
                projectSummary = summarizer.text || undefined;
                brainHistory = summarizer.tailMessages > 0 ? history.slice(-summarizer.tailMessages) : [];
              }
              decision = await decide(llm, session, lastText, guards.turnCount, brainHistory, repoState, projectSummary);
            } catch (e) {
              if (isTransientError(e)) {
                if (await waitForBrain(e instanceof Error ? e.message : String(e))) continue; // back up → re-source
                stopRun("stopped while the local model was unreachable");
                break;
              }
              throw e;
            }

            // No file changes for a while + still "continue" => likely spinning.
            if (decision.action === "continue" && stuck.isStuck(limits.stuckTurns ?? 0)) {
              decision = {
                action: "escalate",
                reason: `no file changes for ${stuck.streak} turns — possible stall`,
                question: `This session may be stuck — no files have changed in the last ${stuck.streak} turns. Continue, redirect, or stop?`,
                options: [
                  { label: "Continue as planned", rationale: "let it proceed with the next step", prompt: decision.prompt ?? "Continue." },
                  {
                    label: "Try a different approach",
                    rationale: "break the loop",
                    prompt:
                      "You appear to be stuck repeating the same approach with no progress. Stop, re-read the goal, state in one line what is actually blocking you, then try a fundamentally different approach.",
                  },
                ],
              };
              stuck.reset();
            }
            emit({ type: "decision", sessionId: session.id, turnNumber: guards.turnCount, decision });

            if (decision.action === "stop") {
              stopRun(decision.reason);
              break;
            }
            if (decision.action === "escalate") {
              const request: AttentionRequest = {
                id: randomUUID(),
                sessionId: session.id,
                turnNumber: guards.turnCount,
                question: decision.question ?? decision.reason,
                options: decision.options ?? [],
                createdAt: Date.now(),
              };
              emit({ type: "attention", sessionId: session.id, turnNumber: guards.turnCount, request });
              const resolution: Resolution = opts.resolveAttention
                ? await opts.resolveAttention(request)
                : { kind: "stop" };
              emit({ type: "attention_resolved", sessionId: session.id, request, resolution });
              if (resolution.kind === "stop") {
                stopRun("human resolved the decision as: stop");
                break;
              }
              pending = resolution.prompt;
            } else {
              pending = decision.prompt!;
            }
          }
        }
      }

      if (pending === null) continue; // mode switch with nothing to run yet

      // ---- run the sourced prompt ----------------------------------------
      const guard = guards.check(pending);
      if (guard.stop) {
        stopRun(guard.reason);
        break;
      }
      const result = await runTurnRecovered(pending);
      // Capture what changed on disk this turn (best-effort; never throws), and
      // pin the post-turn snapshot so it can be rolled back to later.
      if (gitTracked) {
        const curSnapshot = snapshotRef(session.cwd);
        const diff = turnDiff(session.cwd, prevSnapshot, curSnapshot);
        if (diff && diff.files.length > 0) result.diff = diff;
        if (curSnapshot) {
          protectSnapshot(session.cwd, curSnapshot);
          result.snapshot = curSnapshot;
          prevSnapshot = curSnapshot;
        }
      }
      emit({ type: "turn", sessionId: session.id, turnNumber: guards.turnCount, result });
      stuck.record(fingerprintDir(session.cwd)); // did anything change this turn?
      lastResult = result;
      pending = null;

      // ---- context guard: memory-preserving compaction before overflow ----
      const cg = opts.contextGuard;
      if (cg?.enabled && sess.supportsCompaction !== false) {
        // Use Claude's REAL /context usage (tracks the actual window and DROPS
        // after a /compact). Only fall back to the byte estimate if that fails —
        // the estimate never shrinks post-compact, which caused a compaction loop.
        const real = await sess.readContextFraction();
        const used = real ?? (await cg.usedFraction(session.cwd, sess.sessionId, sess.screenText()));
        if (cg.shouldCompact(used, guards.turnCount)) {
          const usedPercent = Math.round(used * 100);
          emit({ type: "context", sessionId: session.id, phase: "compacting", usedPercent });
          await runTurnRecovered(cg.savePrompt()); // write the handoff memory
          await runTurnRecovered("/compact"); // compact the conversation
          lastResult = await runTurnRecovered(cg.resumePrompt()); // resume from the handoff
          cg.markCompacted(guards.turnCount);
          emit({ type: "context", sessionId: session.id, phase: "resumed", usedPercent });
        }
      }

      // ---- real-limit guard: pause on Claude's actual usage limits ----------
      if (ug?.shouldRefresh(guards.turnCount)) limited = await checkUsage();
    }
  } catch (e) {
    if (e instanceof StopRequested) {
      // An operator stop that surfaced mid-turn/mid-recovery is a clean stop.
      emit({
        type: "stop",
        sessionId: session.id,
        reason: "stopped by operator",
        turns: guards.turnCount,
        elapsedMin: guards.elapsedMin,
      });
    } else if (e instanceof RateLimitError) {
      emit({ type: "rate_limited", sessionId: session.id, detail: e.message });
      emit({
        type: "stop",
        sessionId: session.id,
        reason: e.message,
        turns: guards.turnCount,
        elapsedMin: guards.elapsedMin,
      });
    } else {
      const msg = e instanceof AuthError ? e.message : (e as Error).message;
      emit({ type: "error", sessionId: session.id, error: msg });
    }
  } finally {
    await sess.dispose();
  }
}
