/**
 * Deterministic test for the context-window manager's trigger logic — no live
 * claude. Verifies: byte-size → used-fraction estimate (against a seeded
 * transcript file at the real transcript path), the compact threshold + the
 * minTurnsBetween throttle + the enabled switch, and the screen-gauge parser.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ContextGuard, parseScreenContextFraction } from "../src/policy/context.js";
import { transcriptPath } from "../src/transcript/reader.js";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\ctx-test";
const SID = "abcdef01-1111-2222-3333-444455556666";
rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// Seed a transcript file at the path the guard will stat. window=4000 tokens =>
// 16000 bytes is "full" (bytes/4). Write 9000 bytes => ~2250 tokens => ~56%.
const tp = transcriptPath(CWD, SID);
mkdirSync(path.dirname(tp), { recursive: true });
writeFileSync(tp, "x".repeat(9000));

const guard = new ContextGuard({ enabled: true, window: 4000, compactAtPercent: 50, minTurnsBetween: 6 });

const frac = await guard.usedFraction(CWD, SID);
check("estimates ~56% from a 9000-byte transcript (window 4000 tok)", Math.abs(frac - 0.5625) < 0.01);
check("shouldCompact true above the 50% threshold", guard.shouldCompact(frac, 10) === true);
check("shouldCompact false below the threshold", guard.shouldCompact(0.3, 10) === false);

guard.markCompacted(10);
check("throttled right after compacting (minTurnsBetween)", guard.shouldCompact(frac, 12) === false);
check("allowed again once enough turns pass", guard.shouldCompact(frac, 16) === true);

const off = new ContextGuard({ enabled: false, window: 4000, compactAtPercent: 50 });
check("disabled guard never compacts", off.shouldCompact(0.99, 100) === false);

// Empty / missing transcript => 0 use.
const emptyFrac = await guard.usedFraction(CWD, "00000000-0000-0000-0000-000000000000");
check("missing transcript => 0% used", emptyFrac === 0);

// Screen-gauge parser (best-effort; only confident matches return a value).
check("parses '73% context used'", parseScreenContextFraction("  73% context used  ") === 0.73);
check("parses 'context: 12% used'", parseScreenContextFraction("context: 12% used") === 0.12);
check("ignores unrelated text", parseScreenContextFraction("building the app, 80% of tests pass") === null);

// A confident screen gauge overrides the byte estimate.
const fromScreen = await guard.usedFraction(CWD, SID, "90% context used");
check("screen gauge overrides the estimate", fromScreen === 0.9);

rmSync(CWD, { recursive: true, force: true });
console.log(`\n[context] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
