/**
 * Deterministic E2E of the escalation machinery (pause -> options -> resolve ->
 * resume -> stop). Injects a stub `decide` (escalate on turn 1, stop on turn 2)
 * so it doesn't depend on the LLM actually escalating. Uses a real claude session
 * (two cheap turns) to prove the orchestrator + resolveAttention path for real.
 */
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { runSession, type OrchestratorEvent } from "../src/orchestrator.js";
import { LocalLLM } from "../src/brain/provider.js";
import type { Decision, Resolution, SessionConfig } from "../src/types.js";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\esc-loop";
rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

const session: SessionConfig = {
  id: "esc-loop",
  cwd: CWD,
  goal: "Create a file step1.txt containing the word one.",
  doneCriteria: "the requested files exist.",
  permissionMode: "acceptEdits",
};

let calls = 0;
const fakeDecide = async (): Promise<Decision> => {
  calls++;
  if (calls === 1) {
    return {
      action: "escalate",
      reason: "needs a human choice",
      question: "Which second file should I create?",
      options: [
        { label: "step2.txt", rationale: "the numbered follow-up", prompt: "Create step2.txt containing the word two." },
        { label: "skip", rationale: "stop here", prompt: "Do nothing further." },
      ],
    };
  }
  return { action: "stop", reason: "files created" };
};

const events: string[] = [];
let resolvedWith = "";
const resolveAttention = async (): Promise<Resolution> => {
  // simulate the human picking option 0 after a beat
  await new Promise((r) => setTimeout(r, 500));
  resolvedWith = "step2.txt";
  return { kind: "answer", prompt: "Create step2.txt containing the word two.", label: "step2.txt" };
};

const llm = new LocalLLM({ baseUrl: "http://localhost:1234/v1", model: "unused", apiKey: "local" });

await runSession(session, {
  llm,
  limits: { maxTurns: 5, maxWallClockMin: 8, pingPongThreshold: 3 },
  decide: fakeDecide,
  resolveAttention,
  onEvent: (e: OrchestratorEvent) => {
    events.push(e.type);
    if (e.type === "attention") console.log(`  ⏸ attention: "${e.request.question}" (${e.request.options.length} options)`);
    if (e.type === "attention_resolved") console.log(`  ▶ resolved: ${e.resolution.kind === "stop" ? "stop" : e.resolution.label}`);
  },
});

const seq = events.join(" -> ");
console.log(`\n[esc-loop] event sequence:\n  ${seq}`);
const step1 = existsSync(`${CWD}\\step1.txt`);
const step2 = existsSync(`${CWD}\\step2.txt`);
console.log(`[esc-loop] files: step1.txt=${step1} step2.txt=${step2}  | resolved with: ${resolvedWith}`);

const ok =
  events.includes("attention") &&
  events.includes("attention_resolved") &&
  events.filter((e) => e === "turn").length >= 2 &&
  events[events.length - 1] === "stop" &&
  step2;
console.log(`\n[esc-loop] => ${ok ? "PASS ✅ (escalate → resolve → resume → stop, files created)" : "FAIL ⚠️"}`);
process.exit(ok ? 0 : 1);
