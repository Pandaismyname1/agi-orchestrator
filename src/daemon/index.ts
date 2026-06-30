/**
 * Daemon entry point (console runner for now; the web dashboard plugs into the
 * same event stream later).
 *
 * Boot sequence:
 *   1. preflight()  — abort if the env would cause pay-per-token API billing
 *   2. loadConfig() — read config.json
 *   3. LLM health   — confirm the local model (LM Studio/Ollama) is reachable
 *   4. run every configured session concurrently, logging the live event stream
 */
import { preflight, BillingSafetyError } from "../util/env.js";
import { loadConfig } from "../config.js";
import { LocalLLM } from "../brain/provider.js";
import { openStore } from "../db/store.js";
import { Recorder } from "../db/recorder.js";
import { runSession, type OrchestratorEvent } from "../orchestrator.js";
import { ContextGuard } from "../policy/context.js";
import { createLogger, type Logger } from "../util/logger.js";

function log(e: OrchestratorEvent): void {
  const tag = `[${e.sessionId.slice(0, 8)}]`;
  switch (e.type) {
    case "start":
      console.log(`${tag} ▶ START  goal: ${e.goal}`);
      break;
    case "turn":
      console.log(
        `${tag} ◷ turn ${e.turnNumber} done in ${(e.result.durationMs / 1000).toFixed(1)}s` +
          `${e.result.gatesHandled ? `, ${e.result.gatesHandled} gate(s)` : ""}\n` +
          `${tag}   claude: ${oneLine(e.result.assistantText)}`,
      );
      break;
    case "decision":
      if (e.decision.action === "continue") {
        console.log(`${tag} → next: ${oneLine(e.decision.prompt ?? "")}  (${e.decision.reason})`);
      } else if (e.decision.action === "escalate") {
        console.log(`${tag} ⚑ NEEDS A HUMAN: ${oneLine(e.decision.question ?? e.decision.reason)}`);
      } else {
        console.log(`${tag} ✖ brain says STOP: ${e.decision.reason}`);
      }
      break;
    case "attention":
      console.log(
        `${tag} ⏸ paused for decision — ${e.request.options.length} option(s). ` +
          `(headless: no resolver, will stop)`,
      );
      break;
    case "attention_resolved":
      console.log(`${tag} ▶ resolved: ${e.resolution.kind === "stop" ? "stop" : e.resolution.label}`);
      break;
    case "gate":
      console.log(`${tag} ⚠ risky gate: ${e.request.summary} (headless: default-deny)`);
      break;
    case "gate_resolved":
      console.log(`${tag} ${e.resolution.kind === "approve" ? "✓ approved" : "⛔ denied"}: ${e.request.summary}`);
      break;
    case "rate_limited":
      console.log(`${tag} ⏳ RATE LIMITED: ${e.detail}`);
      break;
    case "stop":
      console.log(
        `${tag} ■ STOPPED after ${e.turns} turn(s), ${e.elapsedMin.toFixed(1)}m — ${e.reason}`,
      );
      break;
    case "error":
      console.error(`${tag} ⚠ ERROR: ${e.error}`);
      break;
  }
}

function oneLine(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t || "(no text)";
}

/**
 * Write a durable, structured record of an orchestrator event to the rotating
 * log file. The console already gets the pretty `log(e)` stream; this is the
 * machine-parseable trail for overnight post-mortems.
 */
function record(fileLog: Logger, e: OrchestratorEvent): void {
  const session = e.sessionId.slice(0, 8);
  switch (e.type) {
    case "start":
      fileLog.info("session start", { session, goal: e.goal });
      break;
    case "turn":
      fileLog.info("turn", {
        session,
        turn: e.turnNumber,
        durationMs: Math.round(e.result.durationMs),
        gates: e.result.gatesHandled ?? 0,
      });
      break;
    case "decision":
      fileLog.info("decision", { session, action: e.decision.action, reason: e.decision.reason });
      break;
    case "rate_limited":
      fileLog.warn("rate limited", { session, detail: e.detail });
      break;
    case "stop":
      fileLog.info("session stop", {
        session,
        turns: e.turns,
        elapsedMin: Number(e.elapsedMin.toFixed(1)),
        reason: e.reason,
      });
      break;
    case "error":
      fileLog.error("session error", { session, error: e.error });
      break;
  }
}

async function main(): Promise<void> {
  try {
    preflight();
  } catch (e) {
    if (e instanceof BillingSafetyError) {
      console.error(`\n🛑 BILLING SAFETY:\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const cfg = await loadConfig();
  // File-only structured log (console output stays the pretty `log(e)` stream).
  const fileLog = createLogger({ ...(cfg.logging ?? {}), console: false });
  const llm = new LocalLLM(cfg.provider);
  const store = openStore(cfg.dbPath ?? "agi.db");
  const recorder = new Recorder(store);
  for (const s of cfg.sessions) store.upsertSession(s);
  console.log(`persistent store → ${cfg.dbPath}`);
  if (cfg.logging?.file) console.log(`logging → ${cfg.logging.file} (level ${cfg.logging.level ?? "info"})`);
  fileLog.info("daemon boot", { dbPath: cfg.dbPath, sessions: cfg.sessions.length });

  const health = await llm.health();
  console.log(`local LLM @ ${cfg.provider.baseUrl} (${cfg.provider.model}): ${health.detail}`);
  if (!health.ok) {
    fileLog.error("local model not ready", { baseUrl: cfg.provider.baseUrl, model: cfg.provider.model, detail: health.detail });
    console.error(
      `🛑 local model not ready. Start LM Studio/Ollama and load "${cfg.provider.model}", then retry.`,
    );
    process.exit(1);
  }
  fileLog.info("local LLM ready", { baseUrl: cfg.provider.baseUrl, model: cfg.provider.model });

  console.log(`Running ${cfg.sessions.length} session(s). Ctrl+C to stop.\n`);

  const onEvent = (e: OrchestratorEvent) => {
    log(e);
    record(fileLog, e);
    recorder.record(e);
  };
  await Promise.allSettled(
    cfg.sessions.map((s) =>
      runSession(s, {
        llm,
        limits: cfg.limits,
        onEvent,
        contextGuard: new ContextGuard(cfg.contextGuard),
      }),
    ),
  );

  fileLog.info("all sessions finished");
  console.log("\nAll sessions finished.");
  process.exit(0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
