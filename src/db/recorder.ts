/**
 * Recorder — persists the orchestrator's event stream into the Store.
 *
 * Non-invasive: it just consumes the same `OrchestratorEvent`s the dashboard and
 * console runner already emit, and tracks per-session run/turn ids so it can link
 * turns → runs and decisions → turns. Drop it alongside any existing event sink.
 */
import type { Store } from "./store.js";
import type { OrchestratorEvent } from "../orchestrator.js";

export class Recorder {
  private readonly runBySession = new Map<string, number>();
  private readonly lastTurnBySession = new Map<string, number>();

  constructor(private readonly store: Store) {}

  /** Feed one orchestrator event. Safe to call for every event. */
  record(e: OrchestratorEvent): void {
    try {
      switch (e.type) {
        case "start": {
          const runId = this.store.startRun(e.sessionId);
          this.runBySession.set(e.sessionId, runId);
          this.lastTurnBySession.delete(e.sessionId);
          this.store.addEvent({ sessionId: e.sessionId, runId, type: "start", payload: { goal: e.goal } });
          break;
        }
        case "turn": {
          const runId = this.runBySession.get(e.sessionId);
          if (runId === undefined) break;
          const turnId = this.store.addTurn(runId, {
            n: e.turnNumber,
            prompt: e.result.prompt,
            assistantText: e.result.assistantText,
            durationMs: e.result.durationMs,
            gatesHandled: e.result.gatesHandled,
          });
          this.lastTurnBySession.set(e.sessionId, turnId);
          this.store.addEvent({ sessionId: e.sessionId, runId, type: "turn", payload: { n: e.turnNumber } });
          break;
        }
        case "decision": {
          const turnId = this.lastTurnBySession.get(e.sessionId);
          const runId = this.runBySession.get(e.sessionId);
          if (turnId === undefined) break;
          this.store.addDecision(turnId, {
            action: e.decision.action,
            prompt: e.decision.prompt,
            reason: e.decision.reason,
          });
          this.store.addEvent({ sessionId: e.sessionId, runId, type: "decision", payload: e.decision });
          break;
        }
        case "stop": {
          const runId = this.runBySession.get(e.sessionId);
          if (runId !== undefined) {
            this.store.endRun(runId, "ended", {
              stopReason: e.reason,
              turns: e.turns,
              elapsedMin: e.elapsedMin,
            });
            this.store.addEvent({ sessionId: e.sessionId, runId, type: "stop", payload: { reason: e.reason } });
          }
          this.cleanup(e.sessionId);
          break;
        }
        case "error": {
          const runId = this.runBySession.get(e.sessionId);
          if (runId !== undefined) {
            this.store.endRun(runId, "error", { stopReason: e.error });
            this.store.addEvent({ sessionId: e.sessionId, runId, type: "error", payload: { error: e.error } });
          }
          this.cleanup(e.sessionId);
          break;
        }
      }
    } catch {
      // Persistence must never break a live session — swallow DB errors.
    }
  }

  private cleanup(sessionId: string): void {
    this.runBySession.delete(sessionId);
    this.lastTurnBySession.delete(sessionId);
  }
}
