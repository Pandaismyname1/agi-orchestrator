/**
 * Deterministic tests for the learning loop (A3) — no live claude, no live LLM
 * (the brain is stubbed). Covers: the no-regression invariant on the operator
 * prompt, ProfileStore versioning + revert, override derivation from the store,
 * synthesis (stub LLM), guidance clamping in the service, and the advisory eval
 * delta. Mirrors the seed-a-temp-DB style of the other scripts.
 */
import { rmSync, mkdirSync } from "node:fs";
import { openStore } from "../src/db/store.js";
import { ProfileStore } from "../src/learning/profileStore.js";
import { deriveCorrections, deriveEscalationChoices } from "../src/learning/liveSignals.js";
import { synthesizeProfile } from "../src/learning/synthesize.js";
import { replayEval } from "../src/learning/eval.js";
import { LearningService } from "../src/learning/service.js";
import { buildSystemPrompt } from "../src/brain/decide.js";
import type { LocalLLM } from "../src/brain/provider.js";
import type { ChatMessage } from "../src/brain/provider.js";
import type { ExampleBankItem } from "../src/learning/types.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\learn-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const DB = `${ROOT}\\learn.db`;

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── 1. No-regression invariant: empty/absent guidance == baseline ──────────
const base = buildSystemPrompt("balanced");
check("buildSystemPrompt: no guidance arg == empty guidance", base === buildSystemPrompt("balanced", ""));
check("buildSystemPrompt: whitespace guidance == baseline", base === buildSystemPrompt("balanced", "   "));
const withG = buildSystemPrompt("balanced", "- always run tests first");
check("buildSystemPrompt: guidance is injected", withG.includes("LEARNED OPERATOR PREFERENCES"));
check("buildSystemPrompt: Hard rules stay AFTER learned guidance", withG.indexOf("LEARNED OPERATOR") < withG.indexOf("Hard rules:"));

// ── 2. ProfileStore: versioning + revert + drafts + bank dedupe ────────────
const store = openStore(DB);
const ps = new ProfileStore(store);
const mkBody = (guidance: string) => ({
  schema: 1 as const,
  scope: "global",
  guidance,
  examples: [],
  meta: { fromPastSessions: 0, fromLiveCorrections: 0, model: "stub" },
});
const v1 = ps.saveVersionAndActivate(mkBody("v1 guidance"));
const v2 = ps.saveVersionAndActivate(mkBody("v2 guidance"));
check("versions increment (1 → 2)", v1.version === 1 && v2.version === 2);
check("active is the latest (v2)", ps.getActive("global")?.version === 2);
ps.activateVersion("global", 1); // revert
check("revert repoints active to v1", ps.getActive("global")?.version === 1);
check("revert does NOT mutate the v1 snapshot", ps.getVersion("global", 1)?.guidance === "v1 guidance");
check("listVersions returns both", ps.listVersions("global").length === 2);

ps.appendExamples("global", [
  { situation: "a", instruction: "b", source: "past", hash: "h1", count: 1, lastSeen: 1 },
  { situation: "a", instruction: "b", source: "past", hash: "h1", count: 1, lastSeen: 2 },
  { situation: "c", instruction: "d", source: "live", hash: "h2", count: 1, lastSeen: 1 },
]);
const bank = ps.getExampleBank("global");
check("appendExamples dedupes by hash (2 unique)", bank.items.length === 2);
check("appendExamples bumps count on dupe", (bank.items.find((i) => i.hash === "h1")?.count ?? 0) === 2);

// ── 3. deriveCorrections: detect a manual override, ignore a match ─────────
store.upsertSession({ id: "s1", cwd: "C:\\proj\\x", goal: "g", doneCriteria: "d" });
const runId = store.startRun("s1");
const t1 = store.addTurn(runId, { n: 1, prompt: "g", assistantText: "did A", durationMs: 1, gatesHandled: 0 });
store.addDecision(t1, { action: "continue", prompt: "do B", reason: "" });
const t2 = store.addTurn(runId, { n: 2, prompt: "do B", assistantText: "did B", durationMs: 1, gatesHandled: 0 });
store.addDecision(t2, { action: "continue", prompt: "do C", reason: "" });
// turn 3 injected something DIFFERENT from decision-2's "do C" → an override.
store.addTurn(runId, { n: 3, prompt: "actually, write the docs first", assistantText: "did docs", durationMs: 1, gatesHandled: 0 });

const corr = deriveCorrections(store, runId);
check("derives exactly one override", corr.length === 1);
check("override instruction = what was actually injected", corr[0]?.instruction === "actually, write the docs first");
check("override situation = the agent msg it followed", corr[0]?.situation === "did B");
check("turn-2 (matched qwen) is NOT an override", !corr.some((c) => c.instruction === "do B"));

// ── 4. Synthesis with a stub LLM: bounded draft ────────────────────────────
const synthLLM = { chat: async () => "- be concise\n- escalate on deletes" } as unknown as LocalLLM;
const examples: ExampleBankItem[] = Array.from({ length: 10 }, (_, i) => ({
  situation: `situation ${i}`,
  instruction: `instruction ${i}`,
  source: "past",
  hash: `e${i}`,
  count: 10 - i,
  lastSeen: i,
}));
const draft = await synthesizeProfile(synthLLM, examples, "global", { model: "stub", maxFewShot: 6 });
check("synthesis: guidance non-empty", draft.draft.guidance.length > 0);
check("synthesis: few-shot capped at maxFewShot", draft.draft.examples.length <= 6);
check("synthesis: scope carried", draft.draft.scope === "global");

// ── 5. Service.guidanceFor clamps to the budget ────────────────────────────
const big = "x".repeat(5000);
const svc = new LearningService(store, synthLLM, { enabled: true, guidanceCharBudget: 200 }, "stub");
ps.saveVersionAndActivate(mkBody(big)); // active global guidance is huge
const g = svc.guidanceFor("C:\\proj\\x");
check("guidanceFor clamps to the budget", g.length <= 205 && g.length > 0);
const off = new LearningService(store, synthLLM, { enabled: false }, "stub");
check("guidanceFor returns '' when learning disabled", off.guidanceFor("C:\\proj\\x") === "");

// ── 6. replayEval computes a delta (stub brain favors guidance) ────────────
// The stub echoes the situation as its prompt ONLY when learned guidance is
// present; held-out items have instruction == situation, so the profile run
// matches and the baseline run ("noop") does not → positive delta.
const evalLLM = {
  chat: async (msgs: ChatMessage[]) => {
    const system = msgs[0]?.content ?? "";
    const user = msgs[1]?.content ?? "";
    const sit = user.split("AGENT'S LAST MESSAGE:\n")[1]?.split("\n\n")[0] ?? "";
    const prompt = system.includes("LEARNED OPERATOR PREFERENCES") ? sit : "noop";
    return JSON.stringify({ action: "continue", prompt, reason: "x" });
  },
} as unknown as LocalLLM;
const heldOut: ExampleBankItem[] = [
  { situation: "run the test suite", instruction: "run the test suite", source: "live", hash: "x1", count: 1, lastSeen: 1 },
  { situation: "open a pull request", instruction: "open a pull request", source: "live", hash: "x2", count: 1, lastSeen: 1 },
];
const report = await replayEval(evalLLM, heldOut, "- echo the situation", {});
check("eval: total == held-out size", report.total === 2);
check("eval: profile matches both", report.profileMatch === 2);
check("eval: baseline matches none", report.baselineMatch === 0);
check("eval: positive delta", report.delta === 2);

// ── 7. deriveEscalationChoices: the human's pick becomes a high-weight example ─
const erun = store.startRun("s1");
const et1 = store.addTurn(erun, { n: 1, prompt: "g", assistantText: "two libs found: X and Y", durationMs: 1, gatesHandled: 0 });
const aRow = store.addAttentionRequest(erun, et1, {
  question: "Which HTTP library?",
  options: [
    { label: "Use X", rationale: "lighter", prompt: "use library X and continue" },
    { label: "Use Y", rationale: "typed", prompt: "use library Y and continue" },
  ],
});
store.resolveAttentionRequest(aRow, "Use Y");
// A second escalation the human ended by stopping → no instruction to learn.
const et2 = store.addTurn(erun, { n: 2, prompt: "p", assistantText: "blocked on creds", durationMs: 1, gatesHandled: 0 });
const aRow2 = store.addAttentionRequest(erun, et2, { question: "creds?", options: [{ label: "stop", prompt: "" }] });
store.resolveAttentionRequest(aRow2, "stop");

const esc = deriveEscalationChoices(store, 50);
check("escalation: one choice mined (stop skipped)", esc.length === 1);
check("escalation: instruction = chosen option's prompt", esc[0]?.instruction === "use library Y and continue");
check("escalation: situation = the agent state", esc[0]?.situation === "two libs found: X and Y");
check("escalation: weighted above ordinary overrides", (esc[0]?.count ?? 0) === 3);

store.close();
rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[learn] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
