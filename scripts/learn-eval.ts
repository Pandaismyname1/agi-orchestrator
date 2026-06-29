/**
 * Advisory replay-eval harness for the learning loop (A3).
 *
 * Derives the owner's recent correction examples from the local SQLite store,
 * holds out the most recent slice, synthesizes a DRAFT operator profile from the
 * rest, then replays the held-out corrections through the brain with and without
 * the draft's guidance — reporting whether the profile makes Qwen match the
 * owner's real instructions BETTER (delta > 0). Advisory only: nothing is
 * activated or enforced.
 *
 * Usage: tsx scripts/learn-eval.ts
 *   (reads config.json / $AGI_CONFIG for the provider + db path)
 */
import { loadConfig } from "../src/config.js";
import { openStore } from "../src/db/store.js";
import { LocalLLM } from "../src/brain/provider.js";
import { deriveRecentCorrections } from "../src/learning/liveSignals.js";
import { synthesizeProfile } from "../src/learning/synthesize.js";
import { replayEval } from "../src/learning/eval.js";

const cfg = await loadConfig();
const llm = new LocalLLM(cfg.provider);
const store = openStore(cfg.dbPath ?? "agi.db");

const corrections = deriveRecentCorrections(store, 50);

console.log(`\nLearn-eval: ${cfg.provider.model} @ ${cfg.provider.baseUrl}`);
console.log("─".repeat(60));

if (corrections.length === 0) {
  console.log(
    "No owner corrections found yet — no signal to evaluate.\n" +
      "Keep running sessions (and overriding the brain when it steers wrong) to build a profile.",
  );
  process.exit(0);
}

// Hold out the most recent corrections; synthesize the draft from the rest.
const heldOutCount = cfg.learning?.evalHeldOut ?? 40;
const splitAt = Math.max(0, corrections.length - heldOutCount);
const rest = corrections.slice(0, splitAt);
const heldOut = corrections.slice(splitAt);

console.log(
  `corrections: ${corrections.length}  ·  synthesis: ${rest.length}  ·  held-out: ${heldOut.length}`,
);

const draft = await synthesizeProfile(llm, rest, "global", { model: cfg.provider.model });

console.log("\nDRAFT GUIDANCE");
console.log("─".repeat(60));
console.log(draft.draft.guidance);

console.log("\nReplaying held-out corrections (baseline vs. profile)…");
const report = await replayEval(llm, heldOut, draft.draft.guidance, {});

console.log("\nEVAL REPORT");
console.log("─".repeat(60));
console.log(`total:         ${report.total}`);
console.log(`baselineMatch: ${report.baselineMatch}`);
console.log(`profileMatch:  ${report.profileMatch}`);
console.log(`matchRate:     ${(report.matchRate * 100).toFixed(0)}%`);
console.log(
  `delta:         ${report.delta >= 0 ? "+" : ""}${report.delta}  ` +
    `(${report.delta > 0 ? "profile helped" : report.delta < 0 ? "profile hurt" : "no change"})`,
);
if (report.note) console.log(`note:          ${report.note}`);
console.log("─".repeat(60));
console.log("Advisory only — this report is shown, not enforced.\n");

process.exit(0);

export {};
