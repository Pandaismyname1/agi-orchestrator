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
  const llm = new LocalLLM(cfg.provider);
  const store = openStore(cfg.dbPath ?? "agi.db");
  const recorder = new Recorder(store);
  for (const s of cfg.sessions) store.upsertSession(s);
  console.log(`persistent store → ${cfg.dbPath}`);

  const health = await llm.health();
  console.log(`local LLM @ ${cfg.provider.baseUrl} (${cfg.provider.model}): ${health.detail}`);
  if (!health.ok) {
    console.error(
      `🛑 local model not ready. Start LM Studio/Ollama and load "${cfg.provider.model}", then retry.`,
    );
    process.exit(1);
  }

  console.log(`Running ${cfg.sessions.length} session(s). Ctrl+C to stop.\n`);

  const onEvent = (e: OrchestratorEvent) => {
    log(e);
    recorder.record(e);
  };
  await Promise.allSettled(
    cfg.sessions.map((s) => runSession(s, { llm, limits: cfg.limits, onEvent })),
  );

  console.log("\nAll sessions finished.");
  process.exit(0);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
