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
import { ClaudeSession, AuthError, RateLimitError } from "./session/claudeSession.js";
import { decideNextStep } from "./brain/decide.js";
import { readRecentMessages, readLastAssistantMessage } from "./transcript/reader.js";
import { LocalLLM } from "./brain/provider.js";
import { Guards } from "./policy/guards.js";
import { StuckDetector, fingerprintDir } from "./policy/stuck.js";
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
  | { type: "error"; sessionId: string; error: string };

export type EventSink = (e: OrchestratorEvent) => void;

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
  onSession?: (sess: ClaudeSession) => void;
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
}

export async function runSession(session: SessionConfig, opts: RunOptions): Promise<void> {
  const { llm, onEvent } = opts;
  const emit: EventSink = onEvent ?? (() => {});
  const limits: Limits = { ...opts.limits, ...(session.limits ?? {}) };
  const guards = new Guards(limits);
  const stuck = new StuckDetector();
  // opts.resumeId (a "continue") takes precedence over the session's own resumeId.
  const sess = new ClaudeSession(
    opts.resumeId ? { ...session, resumeId: opts.resumeId } : session,
  );
  // Per-gate safety: a dangerous gate pauses here, is surfaced, and is resolved
  // by the human (resolveGate) or default-denied.
  sess.onGate = async (req): Promise<GateResolution> => {
    emit({ type: "gate", sessionId: session.id, request: req });
    const resolution: GateResolution = opts.resolveGate
      ? await opts.resolveGate(req)
      : { kind: "deny" };
    emit({ type: "gate_resolved", sessionId: session.id, request: req, resolution });
    return resolution;
  };
  opts.onSession?.(sess);

  emit({ type: "start", sessionId: session.id, goal: session.goal });

  try {
    await sess.start();

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

    let pending: string | null = null; // the next prompt to inject, once sourced
    let lastResult: TurnResult | null = null;
    let seeded = false; // whether the opts.seedPrompt (continue) has been injected
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
            const decide = opts.decide ?? decideNextStep;
            let decision = await decide(llm, session, lastText, guards.turnCount, history);

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
      const result = await sess.runTurn(pending);
      emit({ type: "turn", sessionId: session.id, turnNumber: guards.turnCount, result });
      stuck.record(fingerprintDir(session.cwd)); // did anything change this turn?
      lastResult = result;
      pending = null;

      // ---- context guard: memory-preserving compaction before overflow ----
      const cg = opts.contextGuard;
      if (cg?.enabled) {
        // Use Claude's REAL /context usage (tracks the actual window and DROPS
        // after a /compact). Only fall back to the byte estimate if that fails —
        // the estimate never shrinks post-compact, which caused a compaction loop.
        const real = await sess.readContextFraction();
        const used = real ?? (await cg.usedFraction(session.cwd, sess.sessionId, sess.screenText()));
        if (cg.shouldCompact(used, guards.turnCount)) {
          const usedPercent = Math.round(used * 100);
          emit({ type: "context", sessionId: session.id, phase: "compacting", usedPercent });
          await sess.runTurn(cg.savePrompt()); // write the handoff memory
          await sess.runTurn("/compact"); // compact the conversation
          lastResult = await sess.runTurn(cg.resumePrompt()); // resume from the handoff
          cg.markCompacted(guards.turnCount);
          emit({ type: "context", sessionId: session.id, phase: "resumed", usedPercent });
        }
      }

      // ---- real-limit guard: pause on Claude's actual usage limits ----------
      if (ug?.shouldRefresh(guards.turnCount)) limited = await checkUsage();
    }
  } catch (e) {
    if (e instanceof RateLimitError) {
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
