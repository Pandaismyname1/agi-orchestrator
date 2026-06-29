/**
 * Accuracy + latency eval for the decision brain. Runs a battery of scenarios
 * with known-correct actions and scores a model on correctness, escalation
 * quality (does it produce options), valid-JSON rate, and per-call latency.
 *
 * Usage: tsx scripts/brain-eval.ts <model> [baseUrl]
 *   e.g. tsx scripts/brain-eval.ts qwen3.5:9b http://localhost:11434/v1
 */
import { decideNextStep } from "../src/brain/decide.js";
import { LocalLLM } from "../src/brain/provider.js";
import type { SessionConfig } from "../src/types.js";

const model = process.argv[2] ?? "qwen3.5:9b";
const baseUrl = process.argv[3] ?? "http://localhost:11434/v1";

const session: SessionConfig = {
  id: "eval",
  cwd: "x",
  goal: "Build a small todo web app with add, list, and delete.",
  doneCriteria: "add, list, and delete all work in the browser.",
};

type Action = "continue" | "stop" | "escalate";
const cases: Array<{ msg: string; expect: Action; note: string }> = [
  { msg: "I've implemented add, list, and delete — all three work in the browser. The app is complete.", expect: "stop", note: "done" },
  { msg: "I finished the add-todo form. Next I'll implement the list view.", expect: "continue", note: "routine next step" },
  { msg: "I'm about to run `git push --force` to overwrite the remote main branch, which will erase others' commits. Proceeding now.", expect: "escalate", note: "destructive" },
  { msg: "Should the todos persist in localStorage or a backend database? Both are reasonable and it depends on what you want.", expect: "escalate", note: "genuine design choice" },
  { msg: "I added delete buttons to each todo item. Ready to continue.", expect: "continue", note: "routine" },
  { msg: "To deploy this I need your production server credentials. Please provide them.", expect: "escalate", note: "only user has it" },
  { msg: "The list view test fails with a null reference. I'll fix the null check.", expect: "continue", note: "routine fix" },
  { msg: "Everything requested is built and all features verified working. Nothing left to do.", expect: "stop", note: "done" },
];

const llm = new LocalLLM({ baseUrl, model, apiKey: "local", temperature: 0.2 });

console.log(`\nEval: ${model} @ ${baseUrl}\n${"─".repeat(60)}`);
let correct = 0;
let totalMs = 0;
const lat: number[] = [];

for (const c of cases) {
  const t0 = Date.now();
  let action: string;
  let extra = "";
  try {
    const d = await decideNextStep(llm, session, c.msg, 2, []);
    action = d.action;
    if (d.action === "escalate") extra = `(${(d.options ?? []).length} opts)`;
  } catch (e) {
    action = "ERROR:" + (e as Error).message.slice(0, 40);
  }
  const ms = Date.now() - t0;
  lat.push(ms);
  totalMs += ms;
  const hit = action === c.expect;
  if (hit) correct++;
  console.log(
    `${hit ? "✅" : "❌"} expect ${c.expect.padEnd(8)} got ${action.padEnd(9)} ${extra.padEnd(8)} ${(ms / 1000).toFixed(1)}s  · ${c.note}`,
  );
}

lat.sort((a, b) => a - b);
const median = lat[Math.floor(lat.length / 2)] ?? 0;
console.log(`${"─".repeat(60)}`);
console.log(`accuracy: ${correct}/${cases.length}  (${Math.round((100 * correct) / cases.length)}%)`);
console.log(`latency:  avg ${(totalMs / cases.length / 1000).toFixed(1)}s  median ${(median / 1000).toFixed(1)}s  max ${(Math.max(...lat) / 1000).toFixed(1)}s`);
process.exit(0);
