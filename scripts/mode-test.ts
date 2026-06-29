/**
 * Live test of the manual/autopilot mode-aware loop (P1). A real claude session:
 *   1. MANUAL — inject a user message (Qwen silent), it runs as a turn
 *   2. flip to AUTOPILOT — the brain (stub) then drives one more turn, then stops
 * Asserts both turns ran (manual + autopilot files), and the brain was NOT called
 * during the manual phase.
 */
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { runSession, type OrchestratorEvent, type UserInput } from "../src/orchestrator.js";
import { LocalLLM } from "../src/brain/provider.js";
import type { Decision, SessionConfig } from "../src/types.js";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\mode-demo";
rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

const session: SessionConfig = {
  id: "mode-demo", cwd: CWD,
  goal: "Create the requested files.", doneCriteria: "files exist.",
  permissionMode: "acceptEdits", startMode: "manual",
};

let mode: "manual" | "autopilot" = "manual";
let decideCalls = 0;
let decideCalledDuringManual = false;
const turnPrompts: string[] = [];

const inputs: UserInput[] = [
  { kind: "message", text: "Create m1.txt containing the word one." },
  { kind: "switch" }, // hand the wheel to autopilot
];
let i = 0;
const waitForInput = async (): Promise<UserInput> => {
  const inp = inputs[i++] ?? { kind: "stop" };
  if (inp.kind === "switch") mode = "autopilot";
  return inp;
};

const fakeDecide = async (): Promise<Decision> => {
  if (mode === "manual") decideCalledDuringManual = true;
  decideCalls++;
  if (decideCalls === 1) return { action: "continue", prompt: "Create m2.txt containing the word two.", reason: "next" };
  return { action: "stop", reason: "done" };
};

const llm = new LocalLLM({ baseUrl: "http://localhost:11434/v1", model: "unused", apiKey: "local" });

console.log("[mode] running: manual seed -> switch -> autopilot…");
await runSession(session, {
  llm,
  limits: { maxTurns: 6, maxWallClockMin: 8, pingPongThreshold: 4 },
  decide: fakeDecide,
  mode: () => mode,
  waitForInput,
  onEvent: (e: OrchestratorEvent) => {
    if (e.type === "turn") turnPrompts.push(e.result.prompt);
    if (e.type === "decision") console.log(`  brain: ${e.decision.action}`);
  },
});

const m1 = existsSync(`${CWD}\\m1.txt`);
const m2 = existsSync(`${CWD}\\m2.txt`);
console.log(`[mode] turns: ${turnPrompts.length} | first prompt: "${(turnPrompts[0] || "").slice(0, 40)}"`);
console.log(`[mode] m1.txt (manual)=${m1}  m2.txt (autopilot)=${m2}  brain-called-in-manual=${decideCalledDuringManual}`);

const ok =
  m1 && m2 &&
  /m1\.txt|one/i.test(turnPrompts[0] ?? "") && // first turn was the manual message
  !decideCalledDuringManual &&                 // Qwen stayed silent while manual
  decideCalls >= 1;                            // autopilot actually drove
console.log(`\n[mode] => ${ok ? "PASS ✅ (manual seed silent → autopilot took over)" : "FAIL ⚠️"}`);
rmSync(CWD, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
