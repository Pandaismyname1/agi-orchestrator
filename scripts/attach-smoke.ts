/**
 * Standalone test of AttachManager logic — NO network, NO claude, NO brain LLM.
 *
 * Wires AttachManager with a STUB brain (continue twice, then stop) and a STUB
 * readLastMessage (canned text), registers a session, and asserts the decision
 * sequence plus the stop_hook_active short-circuit.
 *
 *   npx tsx scripts/attach-smoke.ts
 */
import {
  AttachManager,
  type AttachBrain,
  type ReadLastMessage,
  type HookBody,
  type HookDecision,
} from "../src/attach/attachManager.js";

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

const SESSION_ID = "test-session-0001";
const CWD = "C:/Users/panda/Desktop/AGI";

// Stub brain: continue with "next step" for the first 2 calls, then stop.
let brainCalls = 0;
const stubBrain: AttachBrain = async (input) => {
  brainCalls++;
  // Sanity: the manager should pass through goal/doneCriteria and an increasing turn number.
  if (input.goal !== "GOAL" || input.doneCriteria !== "DONE") {
    throw new Error(`brain received wrong context: ${JSON.stringify(input)}`);
  }
  if (brainCalls <= 2) {
    return { action: "continue", prompt: "next step", reason: `continue #${brainCalls}` };
  }
  return { action: "stop", reason: "done after two steps" };
};

const stubReadLastMessage: ReadLastMessage = async () => "claude said something canned";

async function run(): Promise<void> {
  const mgr = new AttachManager({
    brain: stubBrain,
    readLastMessage: stubReadLastMessage,
    limits: { maxTurns: 50, maxWallClockMin: 120, pingPongThreshold: 3 },
  });

  // Unregistered session → stop.
  const unreg = await mgr.handle({ session_id: "nope", cwd: CWD });
  assert(unreg.action === "stop" && unreg.prompt === null, "unregistered session stops");

  mgr.register(SESSION_ID, { goal: "GOAL", doneCriteria: "DONE" });
  assert(mgr.isRegistered(SESSION_ID), "session is registered");

  const body: HookBody = { session_id: SESSION_ID, cwd: CWD };

  const r1: HookDecision = await mgr.handle(body);
  assert(r1.action === "continue" && r1.prompt === "next step", "1st handle → continue");

  const r2: HookDecision = await mgr.handle(body);
  assert(r2.action === "continue" && r2.prompt === "next step", "2nd handle → continue");

  const r3: HookDecision = await mgr.handle(body);
  assert(r3.action === "stop" && r3.prompt === null, "3rd handle → stop (brain)");

  // stop_hook_active must short-circuit to stop regardless of brain.
  const callsBefore = brainCalls;
  const loop = await mgr.handle({ ...body, stop_hook_active: true });
  assert(loop.action === "stop" && loop.reason.includes("stop_hook_active"), "stop_hook_active short-circuits");
  assert(brainCalls === callsBefore, "stop_hook_active does NOT call the brain");

  // Error path: a throwing readLastMessage must be caught and mapped to stop.
  const mgr2 = new AttachManager({
    brain: stubBrain,
    readLastMessage: async () => {
      throw new Error("boom");
    },
    limits: { maxTurns: 50, maxWallClockMin: 120, pingPongThreshold: 3 },
  });
  mgr2.register(SESSION_ID, { goal: "GOAL", doneCriteria: "DONE" });
  const err = await mgr2.handle({ session_id: SESSION_ID, cwd: CWD });
  assert(err.action === "stop" && err.reason.startsWith("attach handler error:"), "thrown error maps to stop");

  console.log("");
  if (failures === 0) {
    console.log("PASS — all attach-smoke assertions held");
  } else {
    console.error(`FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("FAIL — unexpected throw:", e);
  process.exit(1);
});
