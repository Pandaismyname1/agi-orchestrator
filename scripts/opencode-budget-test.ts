/**
 * Deterministic test for the OpenCode paid-provider safety gate. No server, no
 * model. Verifies: a non-local provider is REFUSED unattended (error event, no
 * server resolution, no driver) unless opencode.allowPaidProvider is set; local
 * providers always run; and the isLocalOpenCodeProvider classifier.
 */
import {
  runOpenCodeSession,
  isLocalOpenCodeProvider,
  type OpenCodeDriver,
  type OpenCodeDriverFactory,
  type BaseUrlResolver,
} from "../src/opencodeOrchestrator.js";
import type { OrchestratorEvent } from "../src/orchestrator.js";
import type { Decision, SessionConfig } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const baseOpts = (events: OrchestratorEvent[], extra: Partial<Parameters<typeof runOpenCodeSession>[1]> = {}) => ({
  llm: { health: async () => ({ ok: true }) } as never,
  limits: { maxTurns: 25, maxWallClockMin: 60, pingPongThreshold: 3, stuckTurns: 0 },
  decide: (async () => ({ action: "stop", reason: "done" }) as Decision) as never,
  onEvent: (e: OrchestratorEvent) => events.push(e),
  ...extra,
});

const mkSession = (opencode: SessionConfig["opencode"]): SessionConfig => ({
  id: "b1",
  engine: "opencode",
  opencode,
  cwd: "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\oc-budget-nonrepo",
  goal: "do the thing",
  doneCriteria: "done",
});

// --- classifier ------------------------------------------------------------
check("lmstudio is local", isLocalOpenCodeProvider("lmstudio"));
check("Ollama is local (case-insensitive)", isLocalOpenCodeProvider("Ollama"));
check("groq is NOT local", !isLocalOpenCodeProvider("groq"));
check("opencode (cloud) is NOT local", !isLocalOpenCodeProvider("opencode"));

// --- paid provider, no opt-in → refused ------------------------------------
{
  const events: OrchestratorEvent[] = [];
  let resolved = false;
  let created = false;
  const resolveBaseUrl: BaseUrlResolver = async () => {
    resolved = true;
    return "http://mock";
  };
  const createDriver: OpenCodeDriverFactory = () => {
    created = true;
    return {} as OpenCodeDriver;
  };
  await runOpenCodeSession(mkSession({ providerID: "groq", modelID: "llama-3.3-70b-versatile" }), baseOpts(events) as never, {
    resolveBaseUrl,
    createDriver,
  });
  const err = events.find((e) => e.type === "error") as Extract<OrchestratorEvent, { type: "error" }> | undefined;
  check("paid provider without opt-in emits error", !!err && /non-local provider "groq"/.test(err.error));
  check("refused before resolving a server", resolved === false);
  check("refused before creating a driver", created === false);
  check("no start event when refused", !events.some((e) => e.type === "start"));
}

// --- paid provider WITH opt-in → runs --------------------------------------
{
  const events: OrchestratorEvent[] = [];
  let resolved = false;
  const resolveBaseUrl: BaseUrlResolver = async () => {
    resolved = true;
    return "http://mock";
  };
  const createDriver: OpenCodeDriverFactory = (): OpenCodeDriver => ({
    sessionId: "ses_x",
    async start() {},
    async runTurn() {
      return { assistantText: "", permissionsHandled: 0 };
    },
    async dispose() {},
  });
  await runOpenCodeSession(
    mkSession({ providerID: "groq", modelID: "m", allowPaidProvider: true }),
    baseOpts(events) as never,
    { resolveBaseUrl, createDriver },
  );
  check("opt-in allows the paid provider to run (start emitted)", events.some((e) => e.type === "start"));
  check("opt-in path resolved a server", resolved);
  check("opt-in path has no budget error", !events.some((e) => e.type === "error"));
}

// --- local provider always runs (no opt-in needed) -------------------------
{
  const events: OrchestratorEvent[] = [];
  const resolveBaseUrl: BaseUrlResolver = async () => "http://mock";
  const createDriver: OpenCodeDriverFactory = (): OpenCodeDriver => ({
    sessionId: "ses_y",
    async start() {},
    async runTurn() {
      return { assistantText: "", permissionsHandled: 0 };
    },
    async dispose() {},
  });
  await runOpenCodeSession(mkSession({ providerID: "lmstudio", modelID: "m" }), baseOpts(events) as never, {
    resolveBaseUrl,
    createDriver,
  });
  check("local provider runs without opt-in (start, no error)", events.some((e) => e.type === "start") && !events.some((e) => e.type === "error"));
}

console.log(`\n[opencode-budget] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
