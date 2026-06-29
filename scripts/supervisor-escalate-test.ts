/**
 * Deterministic test of the dashboard-facing escalation path: Supervisor flips a
 * session to "needs-input" with the open AttentionRequest, and resolveAttention()
 * unblocks it so the run resumes and ends. Uses an injected escalate stub (no LLM
 * dependence) and a real claude session (two cheap turns).
 */
import { mkdirSync, rmSync } from "node:fs";
import { Supervisor } from "../src/server/supervisor.js";
import type { AppConfig, Decision } from "../src/types.js";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\sup-esc";
rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:1234/v1", model: "unused", apiKey: "local" },
  limits: { maxTurns: 5, maxWallClockMin: 8, pingPongThreshold: 3 },
  sessions: [
    { id: "sup-esc", cwd: CWD, goal: "Create a file a.txt containing the letter a.", doneCriteria: "files exist.", permissionMode: "acceptEdits" },
  ],
};

let calls = 0;
const fakeDecide = async (): Promise<Decision> => {
  calls++;
  if (calls === 1) {
    return {
      action: "escalate", reason: "need a choice", question: "Create b.txt?",
      options: [
        { label: "yes", rationale: "make it", prompt: "Create b.txt containing the letter b." },
        { label: "no", rationale: "skip", prompt: "Do nothing further." },
      ],
    };
  }
  return { action: "stop", reason: "done" };
};

const sup = new Supervisor(cfg, undefined, fakeDecide);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = () => sup.list().find((s) => s.id === "sup-esc")!;

console.log("[sup-esc] starting…");
sup.start("sup-esc");

// wait for the session to flip to needs-input
let waited = 0;
while (view().status !== "needs-input" && waited < 120_000) { await sleep(500); waited += 500; }
const v = view();
const sawNeedsInput = v.status === "needs-input" && !!v.attention;
console.log(`[sup-esc] status=${v.status}  attention=${v.attention ? `"${v.attention.question}" (${v.attention.options.length} opts)` : "none"}`);

if (!sawNeedsInput) {
  console.log("[sup-esc] => FAIL ⚠️ (never reached needs-input)");
  await sup.shutdown();
  process.exit(1);
}

console.log("[sup-esc] resolving option 0…");
sup.resolveAttention("sup-esc", { optionIndex: 0 });

// wait for terminal state
waited = 0;
while (!["done", "stopped", "error"].includes(view().status) && waited < 120_000) { await sleep(500); waited += 500; }
const f = view();
console.log(`[sup-esc] final status=${f.status} turns=${f.turns}`);

const ok = sawNeedsInput && f.status === "done";
console.log(`\n[sup-esc] => ${ok ? "PASS ✅ (needs-input → resolveAttention → resumed → done)" : "FAIL ⚠️"}`);
await sup.shutdown();
process.exit(ok ? 0 : 1);
