/**
 * Deterministic test for runOpenCodeSession — no server, no model, no git. A fake
 * driver stands in for OpenCodeSession and a stub brain (opts.decide) scripts the
 * loop. Proves: goal kickoff → brain-sourced turn → stop, the emitted event
 * stream, and the permission → gate mapping (a driver permission request is
 * routed through resolveGate and answered "once").
 */
import { runOpenCodeSession, type OpenCodeDriver, type OpenCodeDriverFactory } from "../src/opencodeOrchestrator.js";
import type { OpenCodeSessionOptions } from "../src/session/opencodeSession.js";
import type { OrchestratorEvent } from "../src/orchestrator.js";
import type { Decision, SessionConfig } from "../src/types.js";
import { loadConfig } from "../src/config.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ---- fakes ----------------------------------------------------------------
let capturedOnPermission: OpenCodeSessionOptions["onPermission"];
let disposed = false;
const factory: OpenCodeDriverFactory = (o): OpenCodeDriver => {
  capturedOnPermission = o.onPermission;
  return {
    sessionId: "ses_fake",
    async start() {},
    async runTurn(prompt: string) {
      // On the brain-sourced turn, raise a permission to exercise the gate mapping.
      if (prompt === "step2" && capturedOnPermission) {
        const resp = await capturedOnPermission({ id: "perm_x", sessionID: "ses_fake", type: "bash", title: "echo hi" });
        return { assistantText: `did:${prompt} perm=${resp}`, permissionsHandled: 1 };
      }
      return { assistantText: `did:${prompt}`, permissionsHandled: 0 };
    },
    async dispose() {
      disposed = true;
    },
  };
};

// Stub brain: after the goal turn, continue once, then stop.
let decideCalls = 0;
const decide = async (): Promise<Decision> => {
  decideCalls++;
  return decideCalls === 1 ? { action: "continue", prompt: "step2", reason: "next" } : { action: "stop", reason: "done" };
};

const events: OrchestratorEvent[] = [];
let resolveGateCalls = 0;

const session: SessionConfig = {
  id: "oc1",
  engine: "opencode",
  opencode: { baseUrl: "http://mock", providerID: "lmstudio", modelID: "m" },
  cwd: "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\oc-orch-nonrepo", // non-git → no snapshots
  goal: "do the thing",
  doneCriteria: "done when done",
};

await runOpenCodeSession(
  session,
  {
    llm: { health: async () => ({ ok: true }) } as never,
    limits: { maxTurns: 25, maxWallClockMin: 60, pingPongThreshold: 3, stuckTurns: 0 },
    decide,
    onEvent: (e) => events.push(e),
    resolveGate: async () => {
      resolveGateCalls++;
      return { kind: "approve" };
    },
  },
  { createDriver: factory },
);

const types = events.map((e) => e.type);
check("emitted start", types[0] === "start");
const turns = events.filter((e) => e.type === "turn") as Extract<OrchestratorEvent, { type: "turn" }>[];
check("ran exactly 2 turns", turns.length === 2);
check("turn 1 was the goal", turns[0]?.result.prompt === "do the thing");
check("turn 2 was the brain step", turns[1]?.result.prompt === "step2");
check("turn numbers increment", turns[0]?.turnNumber === 1 && turns[1]?.turnNumber === 2);

const decisions = events.filter((e) => e.type === "decision") as Extract<OrchestratorEvent, { type: "decision" }>[];
check("brain decided continue then stop", decisions[0]?.decision.action === "continue" && decisions[1]?.decision.action === "stop");

// permission → gate mapping
check("gate emitted for the permission", types.includes("gate"));
const gr = events.find((e) => e.type === "gate_resolved") as Extract<OrchestratorEvent, { type: "gate_resolved" }> | undefined;
check("gate resolved via resolveGate (approve)", gr?.resolution.kind === "approve" && resolveGateCalls === 1);
check("approval mapped to opencode 'once'", turns[1]?.result.assistantText === "did:step2 perm=once");
check("permissionsHandled surfaced as gatesHandled", turns[1]?.result.gatesHandled === 1);

const stop = events.find((e) => e.type === "stop") as Extract<OrchestratorEvent, { type: "stop" }> | undefined;
check("stopped with brain reason", stop?.reason === "done");
check("driver disposed", disposed);

// ---- config validation: opencode engine requires provider/model -----------
const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\oc-cfg";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const cfgPath = `${ROOT}\\config.json`;
writeFileSync(
  cfgPath,
  JSON.stringify({
    provider: { baseUrl: "http://127.0.0.1:1234/v1", model: "x" },
    sessions: [{ id: "bad", engine: "opencode", cwd: ROOT, goal: "g", doneCriteria: "d" }],
  }),
);
let threw = false;
try {
  await loadConfig(cfgPath);
} catch (e) {
  threw = /opencode\.providerID/.test((e as Error).message);
}
check("loadConfig rejects opencode engine without provider/model", threw);
rmSync(ROOT, { recursive: true, force: true });

console.log(`\n[opencode-orchestrator] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
