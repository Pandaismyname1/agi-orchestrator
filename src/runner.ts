/**
 * Session-runner dispatch: pick the driver by engine. This is the Supervisor's
 * default `RunFn` — Claude Code sessions go through the PTY orchestrator
 * (`runSession`, byte-identical to before), headless Claude sessions through the
 * same orchestrator with a `claude -p` driver factory, and OpenCode sessions
 * through the HTTP orchestrator (`runOpenCodeSession`). Kept in its own module so
 * the engine orchestrators don't import each other and the Supervisor stays
 * engine-agnostic.
 */
import { runSession, type RunOptions } from "./orchestrator.js";
import { runOpenCodeSession } from "./opencodeOrchestrator.js";
import { HeadlessClaudeSession } from "./session/headlessSession.js";
import type { SessionConfig } from "./types.js";

export function runAgentSession(session: SessionConfig, opts: RunOptions): Promise<void> {
  if (session.engine === "opencode") return runOpenCodeSession(session, opts);
  if (session.engine === "claude-headless") {
    return runSession(session, { ...opts, createSession: (c) => new HeadlessClaudeSession(c) });
  }
  return runSession(session, opts);
}
