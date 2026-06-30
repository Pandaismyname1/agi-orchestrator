/**
 * Deterministic tests for the automation chain-depth guard
 * (src/policy/automation.ts: nextChainGen / overChainCap / chainGuard).
 *
 * Pure logic — no supervisor. Models how the supervisor tags each session's run
 * with a causal generation and refuses to fire automations past a cap, so a
 * cyclic rule set ("when A done start B" + "when B done start A") halts instead
 * of looping forever.
 */
import {
  nextChainGen,
  overChainCap,
  chainGuard,
  DEFAULT_CHAIN_CAP,
} from "../src/policy/automation.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── nextChainGen ────────────────────────────────────────────────────────────────
check("root (undefined) → generation 1", nextChainGen(undefined) === 1);
check("root (0) → generation 1", nextChainGen(0) === 1);
check("gen 1 → 2", nextChainGen(1) === 2);
check("gen 5 → 6", nextChainGen(5) === 6);
check("negative parent treated as root", nextChainGen(-3) === 1);
check("fractional parent floors", nextChainGen(2.9) === 3);
check("non-finite parent treated as root", nextChainGen(NaN) === 1 && nextChainGen(Infinity) === 1);

// ── overChainCap ────────────────────────────────────────────────────────────────
check("at cap is NOT over", !overChainCap(8, 8));
check("one past cap is over", overChainCap(9, 8));
check("well under cap is fine", !overChainCap(1, 8));
check("cap 0 disables the guard (never over)", !overChainCap(1000, 0));
check("negative cap disables the guard", !overChainCap(1000, -1));

// ── chainGuard (the combined decision the supervisor uses) ─────────────────────────
const g0 = chainGuard(undefined, 8);
check("first hop from a root is gen 1, not over", g0.gen === 1 && !g0.over);
const gAt = chainGuard(7, 8);
check("hop reaching exactly the cap is allowed", gAt.gen === 8 && !gAt.over);
const gOver = chainGuard(8, 8);
check("hop that would exceed the cap is blocked", gOver.gen === 9 && gOver.over);

// ── simulate a runaway chain: A→B→C… should halt after exactly `cap` hops ──────────
const cap = DEFAULT_CHAIN_CAP;
let parentGen: number | undefined = undefined; // a user-started root session
let hops = 0;
for (let i = 0; i < 1000; i++) {
  const g = chainGuard(parentGen, cap);
  if (g.over) break; // supervisor drops the batch here
  hops++;
  parentGen = g.gen; // the session this hop started inherits this generation
}
check(`a cyclic rule set halts after exactly ${cap} hops`, hops === cap);
check("the chain terminates (does not run to the 1000 iteration ceiling)", hops < 1000);

// ── disabled cap lets the chain run unbounded (here: never blocks in 1000 hops) ─────
let unbounded = 0;
let pg: number | undefined = undefined;
for (let i = 0; i < 1000; i++) {
  const g = chainGuard(pg, 0); // cap 0 = disabled
  if (g.over) break;
  unbounded++;
  pg = g.gen;
}
check("a disabled cap never blocks (chain only stopped by the loop ceiling)", unbounded === 1000);

console.log(`\n[chaindepth] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
