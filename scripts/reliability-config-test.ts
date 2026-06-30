/**
 * Deterministic test for reliability tuning config (clamps + derivations).
 * Pure — no LLM, no store. Validates the bounds that protect the brain retry
 * policy and the auto-pause health-poll cadence from bad/garbage settings.
 */
import {
  normalizeReliability,
  retryOptsFrom,
  brainPollMsFrom,
  RELIABILITY_DEFAULTS,
} from "../src/policy/reliability.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ---- defaults when nothing / garbage provided -------------------------------
const def = normalizeReliability(undefined);
check("undefined → defaults", def.retries === 3 && def.retryBackoffMs === 400 && def.brainPollSeconds === 15);
check("defaults match the exported constants", def.retries === RELIABILITY_DEFAULTS.retries);
const junk = normalizeReliability({ retries: NaN, retryBackoffMs: Infinity, brainPollSeconds: "x" as unknown as number });
check("non-finite/garbage → defaults", junk.retries === 3 && junk.retryBackoffMs === 400 && junk.brainPollSeconds === 15);

// ---- retries: 0 valid (disables), capped at 10 ------------------------------
check("retries 0 is allowed (disables retrying)", normalizeReliability({ retries: 0 }).retries === 0);
check("retries clamps high to 10", normalizeReliability({ retries: 999 }).retries === 10);
check("negative retries floors to 0", normalizeReliability({ retries: -5 }).retries === 0);
check("fractional retries floored", normalizeReliability({ retries: 2.9 }).retries === 2);

// ---- backoff: floored at 50ms, capped at 10s --------------------------------
check("backoff floors to 50ms", normalizeReliability({ retryBackoffMs: 1 }).retryBackoffMs === 50);
check("backoff caps at 10000ms", normalizeReliability({ retryBackoffMs: 99_999 }).retryBackoffMs === 10_000);
check("backoff passes a sane value", normalizeReliability({ retryBackoffMs: 800 }).retryBackoffMs === 800);

// ---- poll: floored at 5s, capped at 300s ------------------------------------
check("poll floors to 5s", normalizeReliability({ brainPollSeconds: 1 }).brainPollSeconds === 5);
check("poll caps at 300s", normalizeReliability({ brainPollSeconds: 9999 }).brainPollSeconds === 300);
check("poll passes a sane value", normalizeReliability({ brainPollSeconds: 30 }).brainPollSeconds === 30);

// ---- derivations -------------------------------------------------------------
const ro = retryOptsFrom({ retries: 5, retryBackoffMs: 250 });
check("retryOptsFrom maps retries → retries", ro.retries === 5);
check("retryOptsFrom maps backoff → baseMs", ro.baseMs === 250);
check("brainPollMsFrom converts seconds → ms", brainPollMsFrom({ brainPollSeconds: 20 }) === 20_000);
check("brainPollMsFrom defaults to 15000", brainPollMsFrom(undefined) === 15_000);

// ---- partial patch keeps the other defaults ---------------------------------
const partial = normalizeReliability({ retries: 1 });
check("partial: retries applied", partial.retries === 1);
check("partial: untouched fields keep defaults", partial.retryBackoffMs === 400 && partial.brainPollSeconds === 15);

console.log(`\n[reliability-config] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
