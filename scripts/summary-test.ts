/**
 * Deterministic tests for the rolling project summary (smarter brain context,
 * slice 2). No live LLM — a counting stub stands in. Covers: first-fold, the
 * re-summarize cadence, empty-history skip, maxChars clamp, error-keeps-prior,
 * and the PROJECT SO FAR injection into the brain prompt (incl. no-regression).
 */
import { RollingSummary } from "../src/brain/summary.js";
import { decideNextStep } from "../src/brain/decide.js";
import type { LocalLLM, ChatMessage } from "../src/brain/provider.js";
import type { SessionConfig } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

type Msg = { role: "user" | "assistant"; text: string };
const hist = (n: number): Msg[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `step ${i}` }) as Msg);

// counting stub that returns a fixed summary
const makeStub = (reply: string) => {
  let calls = 0;
  const llm = { chat: async () => { calls++; return reply; } } as unknown as LocalLLM;
  return { llm, calls: () => calls };
};

// ── 1. first fold + cadence ────────────────────────────────────────────────
const s1 = makeStub("DONE: a. NEXT: b.");
const rs = new RollingSummary({ enabled: true, everyTurns: 4 });
await rs.maybeUpdate(s1.llm, 1, hist(4));
check("first fold sets the summary", rs.text === "DONE: a. NEXT: b.");
check("first fold called the LLM once", s1.calls() === 1);

await rs.maybeUpdate(s1.llm, 2, hist(5));
await rs.maybeUpdate(s1.llm, 3, hist(6));
check("within the cadence window the LLM is NOT called again", s1.calls() === 1);

await rs.maybeUpdate(s1.llm, 5, hist(7)); // turn 5 - lastUpdated 1 >= every 4
check("cadence elapsed → re-summarizes", s1.calls() === 2);

// ── 2. empty history is skipped ────────────────────────────────────────────
const s2 = makeStub("x");
const rs2 = new RollingSummary({ enabled: true });
await rs2.maybeUpdate(s2.llm, 1, []);
check("empty history → no LLM call, empty summary", s2.calls() === 0 && rs2.text === "");

// ── 3. maxChars clamp ──────────────────────────────────────────────────────
const s3 = makeStub("y".repeat(5000));
const rs3 = new RollingSummary({ enabled: true, maxChars: 300 });
await rs3.maybeUpdate(s3.llm, 1, hist(2));
check("summary clamped to maxChars", rs3.text.length === 300);

// ── 4. error keeps the prior summary AND retries next turn ─────────────────
const rs4 = new RollingSummary({ enabled: true, everyTurns: 1 });
const okStub = makeStub("GOOD SUMMARY");
await rs4.maybeUpdate(okStub.llm, 1, hist(2));
check("baseline summary set", rs4.text === "GOOD SUMMARY");
let throws = 0;
const throwing = { chat: async () => { throws++; throw new Error("down"); } } as unknown as LocalLLM;
await rs4.maybeUpdate(throwing, 2, hist(3));
check("LLM error keeps the prior summary", rs4.text === "GOOD SUMMARY");
await rs4.maybeUpdate(throwing, 3, hist(4));
check("error did not advance the cadence (retried next turn)", throws === 2);

// ── 5. PROJECT SO FAR injection through decideNextStep ─────────────────────
let captured = "";
const stub = {
  chat: async (m: ChatMessage[]) => {
    captured = m[1]?.content ?? "";
    return JSON.stringify({ action: "stop", reason: "x" });
  },
} as unknown as LocalLLM;
const session = { id: "s", cwd: ".", goal: "g", doneCriteria: "d" } as SessionConfig;

await decideNextStep(stub, session, "last msg", 3, hist(2), undefined, undefined, undefined, "DONE: foo. NEXT: bar.");
check("PROJECT SO FAR injected when summary present", /PROJECT SO FAR \(maintained running summary\)/.test(captured) && /DONE: foo/.test(captured));

captured = "";
await decideNextStep(stub, session, "last msg", 3, hist(2));
check("no PROJECT SO FAR block when summary omitted (no-regression)", !/PROJECT SO FAR/.test(captured));

console.log(`\n[summary] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
