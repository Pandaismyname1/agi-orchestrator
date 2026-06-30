/**
 * LIVE validation of the smarter-brain features against the REAL local model
 * (Ollama / LM Studio) — NOT part of `npm test` (that suite is deterministic with
 * a stubbed LLM). This answers the questions the offline tests can't:
 *   1. Does Qwen report a USEFUL, roughly-calibrated `confidence`?
 *   2. Does `gateLowConfidence` actually fire on a genuinely ambiguous turn?
 *   3. Does a bigger local model produce BETTER escalation options than the fast one?
 *   4. Does the RollingSummary digest stay accurate and compact?
 *   5. Does REPO STATE (git ground-truth) reach the brain and get used?
 *
 * Subscription-safe: both providers are local loopback endpoints. No server
 * restart, no disruption to any running session — this only reads.
 *
 *   run:  npx tsx scripts/brain-live-validate.ts
 *   env:  BRAIN_FAST  (default qwen3.5:9b @ 11434)
 *         BRAIN_HEAVY (default qwen3-vl:30b-a3b @ 11434; "" to skip heavy pass)
 */
import { LocalLLM } from "../src/brain/provider.js";
import {
  decideNextStep,
  refineEscalation,
  gateLowConfidence,
} from "../src/brain/decide.js";
import { RollingSummary } from "../src/brain/summary.js";
import { gitSummary } from "../src/brain/repoState.js";
import type { Decision, SessionConfig } from "../src/types.js";

const FAST = process.env.BRAIN_FAST ?? "qwen3.5:9b";
const HEAVY = process.env.BRAIN_HEAVY ?? "qwen3-vl:30b-a3b";
const BASE = "http://localhost:11434/v1";

const fast = new LocalLLM({ baseUrl: BASE, model: FAST, apiKey: "local", temperature: 0.3 });
const heavy = HEAVY ? new LocalLLM({ baseUrl: BASE, model: HEAVY, apiKey: "local", temperature: 0.3 }) : null;

const hr = (t: string) => console.log(`\n${"━".repeat(72)}\n${t}\n${"━".repeat(72)}`);
const show = (d: Decision) => {
  console.log(`  action     : ${d.action}`);
  console.log(`  confidence : ${d.confidence ?? "(none reported)"}`);
  if (d.reason) console.log(`  reason     : ${d.reason}`);
  if (d.action === "continue") console.log(`  prompt     : ${d.prompt}`);
  if (d.action === "escalate") {
    console.log(`  question   : ${d.question}`);
    (d.options ?? []).forEach((o, i) =>
      console.log(`   [${i}] ${o.label} — ${o.rationale}\n        → ${o.prompt}`),
    );
  }
};

const session = (over: Partial<SessionConfig> = {}): SessionConfig => ({
  id: "live",
  cwd: process.cwd(),
  goal: "Build a small CLI todo app in TypeScript: add/list/done/remove, persisted to a local JSON file. Plain Node, no framework.",
  doneCriteria: "All four commands work end-to-end against a JSON store, with a short README.",
  autonomy: "balanced",
  ...over,
});

// ── preflight ──────────────────────────────────────────────────────────────
hr("PREFLIGHT — local model health");
const fh = await fast.health();
console.log(`  fast  ${FAST}: ${fh.ok ? "OK" : "✗"} — ${fh.detail}`);
if (!fh.ok) {
  console.error("\nFast model not reachable/available — aborting. Is Ollama up and the model pulled?");
  process.exit(1);
}
if (heavy) {
  const hh = await heavy.health();
  console.log(`  heavy ${HEAVY}: ${hh.ok ? "OK" : "✗"} — ${hh.detail}`);
  if (!hh.ok) console.log("  (heavy unavailable — escalation-refine section will be skipped)");
}

let notes = 0;
const note = (s: string) => { notes++; console.log(`  ⚠ ${s}`); };

// ── 1 & 2. Confidence calibration + low-confidence gate ──────────────────────
hr("1+2. CONFIDENCE — is it reported, roughly calibrated, and does the gate fire?");

// (a) An OBVIOUS continue — agent asks a trivial "shall I keep going?". Expect HIGH confidence.
console.log("\n[a] obvious-next-step turn (expect: continue, HIGH confidence)");
const easy = await decideNextStep(
  fast, session(), "I've created the project skeleton and the `add` command works. Shall I continue with `list`?",
  3, [
    { role: "assistant", text: "Created package.json and src/index.ts." },
    { role: "user", text: "Continue." },
    { role: "assistant", text: "Implemented `add`, writes to todos.json." },
  ],
);
show(easy);
if (typeof easy.confidence !== "number") note("easy turn reported NO confidence — model is ignoring the field.");
else if (easy.confidence < 0.6) note(`easy turn confidence ${easy.confidence} is surprisingly low.`);

// (b) A genuinely AMBIGUOUS turn — agent hit a real fork. Expect LOWER confidence (or escalate).
console.log("\n[b] ambiguous fork (expect: lower confidence, or escalate)");
const ambiguous = await decideNextStep(
  fast, session(), "The `done` command can either mark a todo by its list index or by a fuzzy text match on its title. They behave very differently for the user. Which should I implement?",
  6, [
    { role: "assistant", text: "add/list/remove all work against todos.json." },
    { role: "user", text: "Now do `done`." },
  ],
);
show(ambiguous);
if (typeof ambiguous.confidence === "number" && typeof easy.confidence === "number") {
  console.log(`\n  calibration check: easy=${easy.confidence} vs ambiguous=${ambiguous.confidence}`);
  if (ambiguous.confidence >= easy.confidence)
    note("ambiguous turn was NOT less confident than the easy one — confidence may be noise.");
}

// (c) Does the gate convert a low-confidence continue into an escalation?
console.log("\n[c] gate at threshold 0.7 applied to the ambiguous decision");
const gated = gateLowConfidence(ambiguous, 0.7);
console.log(`  before: ${ambiguous.action} (conf ${ambiguous.confidence ?? "none"})  →  after: ${gated.action}`);
if (ambiguous.action === "continue" && typeof ambiguous.confidence === "number" && ambiguous.confidence < 0.7) {
  if (gated.action === "escalate") console.log("  ✓ low-confidence continue auto-escalated to the human.");
  else note("expected the gate to escalate but it did not.");
} else {
  console.log("  (ambiguous turn wasn't a sub-0.7 continue, so the gate correctly left it alone)");
}

// ── 3. Multi-model escalation refinement ─────────────────────────────────────
hr("3. MULTI-MODEL — does the bigger model sharpen escalation options?");
const escScenario = {
  last: "I'm ready to add persistence. I can use a single JSON file (simple, but rewrites the whole file each change), or better-sqlite3 (robust, but adds a native dependency and build step). This is a real tradeoff for the project — how should I store todos?",
  turn: 5,
  hist: [
    { role: "assistant" as const, text: "Scaffolded the CLI and arg parsing." },
    { role: "user" as const, text: "Good, keep going." },
  ],
};
console.log("\n[fast pass]");
let draft = await decideNextStep(fast, session(), escScenario.last, escScenario.turn, escScenario.hist);
show(draft);
if (draft.action !== "escalate") {
  // Force an escalation draft so we can still exercise refine, and say so.
  console.log("  (fast model did not escalate this turn; synthesizing a draft escalation to exercise refine)");
  draft = {
    action: "escalate",
    reason: "storage backend is a real tradeoff",
    question: "How should todos be persisted?",
    options: [
      { label: "JSON file", rationale: "simplest", prompt: "Use a single JSON file." },
      { label: "sqlite", rationale: "robust", prompt: "Use better-sqlite3." },
    ],
  };
}
if (heavy && (await heavy.health()).ok) {
  console.log("\n[heavy refine] (the 30B may take a while to load on first call…)");
  const t0 = process.hrtime.bigint();
  const refined = await refineEscalation(heavy, session(), escScenario.last, escScenario.turn, escScenario.hist, undefined, draft);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  show(refined);
  console.log(`  heavy refine took ${Math.round(ms)}ms`);
  const drewN = draft.options?.length ?? 0;
  const refN = refined.options?.length ?? 0;
  if (refined === draft) note("refine returned the draft unchanged (heavy failed or gave no usable options — fell back, which is the safe path).");
  else console.log(`  draft had ${drewN} option(s); refined has ${refN}. Eyeball whether the refined prompts are sharper/more distinct.`);
} else {
  console.log("\n[heavy refine] skipped — no heavy model available.");
}

// ── 4. Rolling summary accuracy ──────────────────────────────────────────────
hr("4. ROLLING SUMMARY — is the maintained digest accurate and compact?");
const rs = new RollingSummary({ enabled: true, everyTurns: 1, maxChars: 1200 });
const story: Array<{ role: "user" | "assistant"; text: string }> = [
  { role: "assistant", text: "Scaffolded the project: package.json, tsconfig, src/index.ts with a yargs-style arg parser." },
  { role: "user", text: "Add the `add` command." },
  { role: "assistant", text: "`add <title>` appends a {id,title,done:false} record to todos.json. Tested manually, works." },
  { role: "user", text: "Now `list`." },
  { role: "assistant", text: "`list` prints all todos with [x]/[ ] and their index. Done." },
  { role: "user", text: "Now `done <index>` and `remove <index>`." },
  { role: "assistant", text: "Both implemented against the index. Hit a bug: removing shifted indices mid-loop; fixed by iterating a copy." },
];
await rs.maybeUpdate(fast, 1, story);
console.log(`\n  summary (${rs.text.length} chars, cap 1200):\n`);
console.log(rs.text.split("\n").map((l) => `    ${l}`).join("\n"));
if (!rs.text) note("rolling summary came back EMPTY.");
else {
  const lc = rs.text.toLowerCase();
  const hits = ["add", "list", "done", "remove"].filter((k) => lc.includes(k));
  console.log(`\n  key-fact coverage: mentions ${hits.length}/4 commands [${hits.join(", ")}]`);
  if (hits.length < 3) note("summary missed most of the commands actually built — may be too lossy.");
}

// ── 5. REPO STATE end-to-end (real git) ──────────────────────────────────────
hr("5. REPO STATE — does git ground-truth reach the brain and get used?");
const repo = await gitSummary(process.cwd());
console.log(`\n  gitSummary(${process.cwd()}):\n${repo.split("\n").map((l) => `    ${l}`).join("\n") || "    (empty — not a repo?)"}`);
console.log("\n[claims-vs-disk test] agent claims it committed, REPO STATE is the truth:");
const claim = await decideNextStep(
  fast,
  session({ goal: "Add a CONTRIBUTING.md to this repo.", doneCriteria: "CONTRIBUTING.md exists and is committed." }),
  "Done — I created CONTRIBUTING.md and committed it. The task is complete.",
  4, undefined, undefined, repo,
);
show(claim);
console.log("\n  → If the repo tree is CLEAN / has no CONTRIBUTING.md, a good operator should NOT just stop-as-done;");
console.log("    it should notice the disk doesn't back the claim. Check the reason above references repo state.");

// ── verdict ──────────────────────────────────────────────────────────────────
hr(`DONE — ${notes} caution note(s) raised`);
console.log(notes === 0
  ? "No red flags. Eyeball the printed decisions/summary above for quality, then enable the knobs in config.json."
  : "Some cautions above — read them; they flag where real Qwen behavior diverged from the design's assumptions.");
process.exit(0);
