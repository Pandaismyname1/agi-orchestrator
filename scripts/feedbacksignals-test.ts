/**
 * Deterministic test for feedback → prompt integration (learning loop):
 * deriveFeedback turns thumbed decisions into positive/negative ExampleBankItems,
 * and synthesizeProfile renders an AVOID block from negatives while keeping
 * few-shot examples positives-only. Stub LLM, temp DB — no network, no claude.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db/store.js";
import { deriveFeedback, deriveRecentFeedback, deriveRecentFeedbackByCwd } from "../src/learning/feedbackSignals.js";
import { synthesizeProfile } from "../src/learning/synthesize.js";
import type { LocalLLM, ChatMessage } from "../src/brain/provider.js";
import type { ExampleBankItem } from "../src/learning/types.js";

const dir = mkdtempSync(join(tmpdir(), "agi-fbsig-"));
const store = openStore(join(dir, "fb.db"));

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// --- seed a run: 3 continue decisions; rate #1 up, #2 down, #3 unrated -------
store.upsertSession({ id: "s1", cwd: "C:\\proj", goal: "g", doneCriteria: "d" });
const runId = store.startRun("s1");
for (let n = 1; n <= 3; n++) {
  const tid = store.addTurn(runId, { n, prompt: `p${n}`, assistantText: `agent said ${n}`, durationMs: 1, gatesHandled: 0 });
  store.addDecision(tid, { action: "continue", prompt: `do step ${n + 1}`, reason: "r" });
}
store.setDecisionFeedback("s1", runId, 1, "up");
store.setDecisionFeedback("s1", runId, 2, "down");

const items = deriveFeedback(store, runId);
check("derives exactly two rated decisions", items.length === 2);

const up = items.find((i) => i.kind === "positive");
const down = items.find((i) => i.kind === "negative");
check("up-rated → a positive example", !!up);
check("down-rated → a negative example", !!down);
check("positive situation = the rated turn's agent message", up?.situation === "agent said 1");
check("positive instruction = the brain's proposed prompt", up?.instruction === "do step 2");
check("negative situation = its turn's agent message", down?.situation === "agent said 2");
check("negative instruction = the rejected prompt", down?.instruction === "do step 3");
check("up is weighted heavily (4)", up?.count === 4);
check("down is weighted (2)", down?.count === 2);
check("both are live-source", up?.source === "live" && down?.source === "live");
check("negative hash is namespaced (-neg)", (down?.hash ?? "").endsWith("-neg"));
check("positive & negative hashes differ", up?.hash !== down?.hash);

// --- a 'stop' decision rated up yields a synthetic stop instruction ----------
const r2 = store.startRun("s1");
const st = store.addTurn(r2, { n: 1, prompt: "p", assistantText: "looks complete", durationMs: 1, gatesHandled: 0 });
store.addDecision(st, { action: "stop", reason: "done" });
store.setDecisionFeedback("s1", r2, 1, "up");
const stopItems = deriveFeedback(store, r2);
check("rated stop decision is captured", stopItems.length === 1);
check("stop instruction is synthetic", (stopItems[0]?.instruction ?? "").startsWith("stop the session"));

// --- deriveRecentFeedback spans runs -----------------------------------------
const recent = deriveRecentFeedback(store, 50);
check("recent feedback spans both runs (3 items)", recent.length === 3);

// --- per-cwd grouping: a thumb tunes its OWN project's bank, not just global --
store.upsertSession({ id: "s2", cwd: "C:\\other", goal: "g2", doneCriteria: "d2" });
const r2b = store.startRun("s2");
const t2b = store.addTurn(r2b, { n: 1, prompt: "p", assistantText: "other-agent said", durationMs: 1, gatesHandled: 0 });
store.addDecision(t2b, { action: "continue", prompt: "do the other thing", reason: "r" });
store.setDecisionFeedback("s2", r2b, 1, "up");

const byCwd = deriveRecentFeedbackByCwd(store, (id) => store.sessionCwd(id), 50);
check("byCwd groups both projects", byCwd.size === 2);
check("s1's project gets its 3 feedback items", (byCwd.get("C:\\proj") ?? []).length === 3);
check("s2's project gets its 1 feedback item", (byCwd.get("C:\\other") ?? []).length === 1);
check(
  "the s2 item is the right decision",
  (byCwd.get("C:\\other") ?? [])[0]?.instruction === "do the other thing",
);

// A run whose cwd can't be resolved is skipped (still counts globally elsewhere).
const byCwdPartial = deriveRecentFeedbackByCwd(store, (id) => (id === "s2" ? undefined : store.sessionCwd(id)), 50);
check("unresolvable cwd is skipped", !byCwdPartial.has("C:\\other") && byCwdPartial.has("C:\\proj"));

// --- unrated decisions produce nothing ---------------------------------------
const r3 = store.startRun("s1");
const ut = store.addTurn(r3, { n: 1, prompt: "p", assistantText: "x", durationMs: 1, gatesHandled: 0 });
store.addDecision(ut, { action: "continue", prompt: "y", reason: "r" });
check("a run with no thumbs yields no feedback items", deriveFeedback(store, r3).length === 0);

// --- synthesize: AVOID block rendered from negatives, few-shot positives-only -
let captured = "";
const stubLLM = {
  chat: async (msgs: ChatMessage[]) => {
    captured = msgs[1]?.content ?? "";
    return "- be concise";
  },
} as unknown as LocalLLM;

const mixed: ExampleBankItem[] = [
  { situation: "agent finished tests", instruction: "open a PR", source: "live", kind: "positive", hash: "p1", count: 5, lastSeen: 2 },
  { situation: "agent asked to delete data", instruction: "rm -rf the folder", source: "live", kind: "negative", hash: "n1-neg", count: 3, lastSeen: 3 },
];
const draft = await synthesizeProfile(stubLLM, mixed, "global", { model: "stub", maxFewShot: 6 });
check("synthesis still produces guidance", draft.draft.guidance.length > 0);
check("few-shot excludes negatives", draft.draft.examples.every((e) => e.instruction !== "rm -rf the folder"));
check("few-shot keeps the positive", draft.draft.examples.some((e) => e.instruction === "open a PR"));
check("LLM input contains an AVOID block", captured.includes("AVOID — the user thumbed this DOWN"));
check("AVOID block carries the rejected instruction", captured.includes("rm -rf the folder"));
check("positive still rendered as a normal SITUATION/INSTRUCTION", captured.includes("INSTRUCTION: open a PR"));

// --- synthesis from ONLY negatives still works (no positives at all) ---------
const onlyNeg: ExampleBankItem[] = [
  { situation: "agent proposed force-push", instruction: "git push --force", source: "live", kind: "negative", hash: "n2-neg", count: 2, lastSeen: 1 },
];
const negDraft = await synthesizeProfile(stubLLM, onlyNeg, "global", { model: "stub" });
check("negatives-only still calls the LLM (non-empty guidance)", negDraft.draft.guidance === "- be concise");
check("negatives-only has no few-shot examples", negDraft.draft.examples.length === 0);

store.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n[feedbacksignals] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
