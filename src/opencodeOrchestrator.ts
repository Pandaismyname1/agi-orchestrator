/**
 * The autopilot loop for one OpenCode session — the HTTP-engine counterpart to
 * `runSession` (which drives Claude Code through a PTY). It emits the SAME
 * `OrchestratorEvent` stream and honors the same `RunOptions`, so the Supervisor
 * drives it identically; `runAgentSession` (src/runner.ts) dispatches to it when
 * a session's `engine` is "opencode".
 *
 * What it reuses from the Claude path (engine-agnostic): the local-brain decision
 * (`decideNextStep`), `Guards` (turn/time/ping-pong caps), `StuckDetector`, git
 * per-turn snapshots, and the escalate/manual/stop control flow.
 *
 * What differs from Claude:
 *  - No PTY/screen: assistant text comes straight from the turn's HTTP response,
 *    and history is kept in-memory (no transcript-path reconstruction).
 *  - No `/usage` or `/context`: OpenCode has neither panel, so the usage/context
 *    guards are inert here. Cost governance for a PAID provider is a TODO (the
 *    common local `lmstudio` case is subscription-safe).
 *  - Permissions instead of gates: an OpenCode permission request is mapped onto
 *    the existing dangerous-gate path (`resolveGate` + gate events), answered
 *    "once"/"reject" — concurrently, while the blocking turn POST is in flight.
 */
import { randomUUID } from "node:crypto";
import { OpenCodeSession, type OpenCodeSessionOptions } from "./session/opencodeSession.js";
import { getSharedServer, hookProcessCleanup } from "./session/opencodeServer.js";
import { decideNextStep } from "./brain/decide.js";
import { gitSummary } from "./brain/repoState.js";
import { isTransientError } from "./brain/provider.js";
import { Guards } from "./policy/guards.js";
import { StuckDetector, fingerprintDir } from "./policy/stuck.js";
import { isGitRepo, snapshotRef, turnDiff, protectSnapshot } from "./git/diff.js";
import type { EventSink, RunOptions } from "./orchestrator.js";
import type {
  AttentionRequest,
  Decision,
  GateRequest,
  Limits,
  Resolution,
  SessionConfig,
  TurnResult,
} from "./types.js";

/** The slice of OpenCodeSession the loop needs — swappable for a fake in tests. */
export interface OpenCodeDriver {
  readonly sessionId: string;
  start(): Promise<void>;
  runTurn(prompt: string): Promise<{ assistantText: string; permissionsHandled: number }>;
  dispose(): Promise<void>;
}

/** Factory so tests can inject a driver without a live `opencode serve`. */
export type OpenCodeDriverFactory = (opts: OpenCodeSessionOptions) => OpenCodeDriver;

/** Resolve the base URL to drive against (tests inject to avoid spawning a server). */
export type BaseUrlResolver = (oc: { baseUrl?: string; port?: number }) => Promise<string>;

const defaultFactory: OpenCodeDriverFactory = (opts) => new OpenCodeSession(opts);

/**
 * Default base-URL resolution: attach to an explicit baseUrl, else spawn/attach a
 * managed `opencode serve` on the configured port (shared across sessions).
 */
const defaultResolveBaseUrl: BaseUrlResolver = async (oc) => {
  if (oc.baseUrl) return oc.baseUrl;
  hookProcessCleanup();
  return getSharedServer({ port: oc.port }).ensure();
};

/**
 * Drive one OpenCode session to its done-criteria (or a guard/limit). Matches the
 * `RunFn` signature; `deps.createDriver` is injected by tests.
 */
export async function runOpenCodeSession(
  session: SessionConfig,
  opts: RunOptions,
  deps: { createDriver?: OpenCodeDriverFactory; resolveBaseUrl?: BaseUrlResolver } = {},
): Promise<void> {
  const { llm, onEvent } = opts;
  const emit: EventSink = onEvent ?? (() => {});
  const limits: Limits = { ...opts.limits, ...(session.limits ?? {}) };
  const guards = new Guards(limits);
  const stuck = new StuckDetector();
  const createDriver = deps.createDriver ?? defaultFactory;
  const resolveBaseUrl = deps.resolveBaseUrl ?? defaultResolveBaseUrl;

  const oc = session.opencode;
  if (!oc?.providerID || !oc?.modelID) {
    emit({ type: "error", sessionId: session.id, error: "opencode engine requires session.opencode.providerID and modelID" });
    return;
  }

  // Resolve where to drive: an explicit baseUrl, or a managed `opencode serve`
  // (spawned/attached automatically). A failure here (server won't come up) ends
  // the run with a clear error instead of throwing past the caller.
  let baseUrl: string;
  try {
    baseUrl = await resolveBaseUrl(oc);
  } catch (e) {
    emit({ type: "error", sessionId: session.id, error: `opencode serve unavailable: ${(e as Error).message}` });
    return;
  }

  // Map an OpenCode permission request onto the existing dangerous-gate path so
  // the dashboard surfaces it and the operator/policy decides. Runs concurrently
  // with the blocked turn POST — answering it is what lets the turn finish.
  const sess = createDriver({
    baseUrl,
    providerID: oc.providerID,
    modelID: oc.modelID,
    agent: oc.agent,
    title: session.goal.slice(0, 80),
    onPermission: async (perm) => {
      const req: GateRequest = {
        id: randomUUID(),
        sessionId: session.id,
        summary: `${perm.type ?? "action"}${perm.title ? `: ${perm.title}` : ""}`,
      };
      emit({ type: "gate", sessionId: session.id, request: req });
      const resolution = opts.resolveGate ? await opts.resolveGate(req) : { kind: "deny" as const };
      emit({ type: "gate_resolved", sessionId: session.id, request: req, resolution });
      return resolution.kind === "approve" ? "once" : "reject";
    },
  });

  emit({ type: "start", sessionId: session.id, goal: session.goal });

  const stopRun = (reason: string) =>
    emit({ type: "stop", sessionId: session.id, reason, turns: guards.turnCount, elapsedMin: guards.elapsedMin });

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const brainPollMs = opts.brainPollMs && opts.brainPollMs > 0 ? opts.brainPollMs : 15_000;
  const waitForBrain = async (detail: string): Promise<boolean> => {
    emit({ type: "brain", sessionId: session.id, phase: "unreachable", detail });
    for (;;) {
      if (opts.shouldStop?.()) return false;
      await sleep(brainPollMs);
      if (opts.shouldStop?.()) return false;
      if ((await llm.health()).ok) {
        emit({ type: "brain", sessionId: session.id, phase: "recovered" });
        return true;
      }
    }
  };

  // In-memory transcript fed to the brain (no on-disk reconstruction needed —
  // each turn's reply comes back from the HTTP response).
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  const decide =
    opts.decide ??
    ((llm2, s, lt, tn, h, rs, ps) => decideNextStep(llm2, s, lt, tn, h, undefined, rs, undefined, ps));

  try {
    await sess.start();

    const gitTracked = isGitRepo(session.cwd);
    let prevSnapshot = gitTracked ? snapshotRef(session.cwd) : null;
    let pending: string | null = null;
    let lastText = "";
    let started = false; // has at least one turn run?
    let seeded = false;

    while (true) {
      const stopSignal = opts.shouldStop?.();
      if (stopSignal) {
        stopRun(typeof stopSignal === "string" ? stopSignal : "stopped by operator");
        break;
      }
      const mode = opts.mode?.() ?? "autopilot";

      // ---- source the next prompt ----------------------------------------
      if (pending === null) {
        if (!seeded && opts.seedPrompt) {
          pending = opts.seedPrompt;
          seeded = true;
        } else if (mode === "manual") {
          const inp = opts.waitForInput ? await opts.waitForInput() : ({ kind: "stop" } as const);
          if (inp.kind === "stop") {
            stopRun("stopped by operator");
            break;
          }
          if (inp.kind === "switch") continue;
          pending = inp.text;
        } else if (!started && session.goal) {
          pending = session.goal; // kick off a fresh autopilot run with the goal
        } else {
          let decision: Decision;
          const repoState = await gitSummary(session.cwd);
          try {
            decision = await decide(llm, session, lastText, guards.turnCount, history.slice(-8), repoState, undefined);
          } catch (e) {
            if (isTransientError(e)) {
              if (await waitForBrain(e instanceof Error ? e.message : String(e))) continue;
              stopRun("stopped while the local model was unreachable");
              break;
            }
            throw e;
          }

          if (decision.action === "continue" && stuck.isStuck(limits.stuckTurns ?? 0)) {
            decision = {
              action: "escalate",
              reason: `no file changes for ${stuck.streak} turns — possible stall`,
              question: `This session may be stuck — no files have changed in the last ${stuck.streak} turns. Continue, redirect, or stop?`,
              options: [
                { label: "Continue as planned", rationale: "let it proceed", prompt: decision.prompt ?? "Continue." },
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
            const resolution: Resolution = opts.resolveAttention ? await opts.resolveAttention(request) : { kind: "stop" };
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

      if (pending === null) continue;

      // ---- run the sourced prompt ----------------------------------------
      const guard = guards.check(pending);
      if (guard.stop) {
        stopRun(guard.reason);
        break;
      }
      const startedAt = Date.now();
      const turn = await sess.runTurn(pending);
      started = true;

      const result: TurnResult = {
        prompt: pending,
        assistantText: turn.assistantText,
        gatesHandled: turn.permissionsHandled,
        durationMs: Date.now() - startedAt,
      };
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
      stuck.record(fingerprintDir(session.cwd));

      history.push({ role: "user", text: pending });
      history.push({ role: "assistant", text: turn.assistantText });
      lastText = turn.assistantText;
      pending = null;
    }
  } catch (e) {
    emit({ type: "error", sessionId: session.id, error: (e as Error).message });
  } finally {
    await sess.dispose();
  }
}
