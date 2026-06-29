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
import { ClaudeSession, AuthError } from "./session/claudeSession.js";
import { decideNextStep } from "./brain/decide.js";
import { readRecentMessages } from "./transcript/reader.js";
import { LocalLLM } from "./brain/provider.js";
import { Guards } from "./policy/guards.js";
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
  | { type: "stop"; sessionId: string; reason: string; turns: number; elapsedMin: number }
  | { type: "error"; sessionId: string; error: string };

export type EventSink = (e: OrchestratorEvent) => void;

export interface RunOptions {
  llm: LocalLLM;
  limits: Limits;
  onEvent?: EventSink;
  /** Hands the live session to the caller (for dashboard screen reads + stop). */
  onSession?: (sess: ClaudeSession) => void;
  /** Checked at the top of each loop iteration; return true to stop gracefully. */
  shouldStop?: () => boolean;
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
}

export async function runSession(session: SessionConfig, opts: RunOptions): Promise<void> {
  const { llm, onEvent } = opts;
  const emit: EventSink = onEvent ?? (() => {});
  const limits: Limits = { ...opts.limits, ...(session.limits ?? {}) };
  const guards = new Guards(limits);
  const sess = new ClaudeSession(session);
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

    let prompt = session.goal;
    while (true) {
      if (opts.shouldStop?.()) {
        emit({
          type: "stop",
          sessionId: session.id,
          reason: "stopped by operator",
          turns: guards.turnCount,
          elapsedMin: guards.elapsedMin,
        });
        break;
      }
      const guard = guards.check(prompt);
      if (guard.stop) {
        emit({
          type: "stop",
          sessionId: session.id,
          reason: guard.reason,
          turns: guards.turnCount,
          elapsedMin: guards.elapsedMin,
        });
        break;
      }

      const result = await sess.runTurn(prompt);
      emit({ type: "turn", sessionId: session.id, turnNumber: guards.turnCount, result });

      // Feed the brain recent history (our injected prompts + claude's replies) so
      // its decisions stay anchored on long projects, not just the last message.
      const history = await readRecentMessages(session.cwd, sess.sessionId, 8);
      const decide = opts.decide ?? decideNextStep;
      const decision = await decide(llm, session, result.assistantText, guards.turnCount, history);
      emit({ type: "decision", sessionId: session.id, turnNumber: guards.turnCount, decision });

      if (decision.action === "stop") {
        emit({
          type: "stop",
          sessionId: session.id,
          reason: decision.reason,
          turns: guards.turnCount,
          elapsedMin: guards.elapsedMin,
        });
        break;
      }

      if (decision.action === "escalate") {
        // A genuine human decision. Pause: surface options and wait for a choice.
        const request: AttentionRequest = {
          id: randomUUID(),
          sessionId: session.id,
          turnNumber: guards.turnCount,
          question: decision.question ?? decision.reason,
          options: decision.options ?? [],
          createdAt: Date.now(),
        };
        emit({ type: "attention", sessionId: session.id, turnNumber: guards.turnCount, request });

        // No resolver (e.g. headless run with no human) -> safe stop.
        const resolution: Resolution = opts.resolveAttention
          ? await opts.resolveAttention(request)
          : { kind: "stop" };
        emit({ type: "attention_resolved", sessionId: session.id, request, resolution });

        if (resolution.kind === "stop") {
          emit({
            type: "stop",
            sessionId: session.id,
            reason: "human resolved the decision as: stop",
            turns: guards.turnCount,
            elapsedMin: guards.elapsedMin,
          });
          break;
        }
        prompt = resolution.prompt; // chosen option (or custom) becomes the next instruction
        continue;
      }

      prompt = decision.prompt!;
    }
  } catch (e) {
    const msg = e instanceof AuthError ? e.message : (e as Error).message;
    emit({ type: "error", sessionId: session.id, error: msg });
  } finally {
    await sess.dispose();
  }
}
