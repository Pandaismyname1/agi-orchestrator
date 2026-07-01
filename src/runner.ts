/**
 * Session-runner dispatch: pick the driver by engine. This is the Supervisor's
 * default `RunFn` — Claude Code sessions go through the PTY orchestrator
 * (`runSession`, byte-identical to before), OpenCode sessions through the HTTP
 * orchestrator (`runOpenCodeSession`). Kept in its own module so the two engine
 * orchestrators don't import each other and the Supervisor stays engine-agnostic.
 */
import { runSession, type RunOptions } from "./orchestrator.js";
import { runOpenCodeSession } from "./opencodeOrchestrator.js";
import type { SessionConfig } from "./types.js";

export function runAgentSession(session: SessionConfig, opts: RunOptions): Promise<void> {
  return session.engine === "opencode" ? runOpenCodeSession(session, opts) : runSession(session, opts);
}
