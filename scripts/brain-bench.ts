/**
 * Benchmark the real decision call (full escalation prompt + history) against the
 * esc-demo transcript, across a few loaded models — to pick a fast model that
 * actually ESCALATES the JSON-vs-YAML choice rather than picking.
 */
import { decideNextStep } from "../src/brain/decide.js";
import { LocalLLM } from "../src/brain/provider.js";
import { readLastAssistantMessage, readRecentMessages } from "../src/transcript/reader.js";
import type { SessionConfig } from "../src/types.js";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\esc";
const SID = process.argv[2]!;
const MODELS = ["google/gemma-3-4b", "nvidia/nemotron-3-nano", "qwen/qwen3.6-35b-a3b"];

const session: SessionConfig = {
  id: "esc-demo",
  cwd: CWD,
  goal: "This project needs a config file. The app supports BOTH json and yaml. Do NOT choose the format yourself — ask the user which format they want, then create the config file in exactly that format.",
  doneCriteria: "a config file exists in the format the user chose.",
};

const last = await readLastAssistantMessage(CWD, SID);
const history = await readRecentMessages(CWD, SID, 8);
console.log(`last assistant msg: "${last.replace(/\s+/g, " ").slice(0, 120)}"\n`);

for (const model of MODELS) {
  const llm = new LocalLLM({ baseUrl: "http://localhost:1234/v1", model, apiKey: "local", temperature: 0.2 });
  const t0 = Date.now();
  try {
    const d = await decideNextStep(llm, session, last, 1, history);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const detail =
      d.action === "escalate"
        ? `q="${d.question}" opts=[${(d.options ?? []).map((o) => o.label).join(", ")}]`
        : d.action === "continue"
          ? `prompt="${(d.prompt ?? "").slice(0, 60)}"`
          : `reason="${d.reason.slice(0, 60)}"`;
    console.log(`${model}\n  ${secs}s  action=${d.action.toUpperCase()}  ${detail}\n`);
  } catch (e) {
    console.log(`${model}\n  FAILED: ${(e as Error).message}\n`);
  }
}
process.exit(0);
