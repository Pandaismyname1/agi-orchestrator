/**
 * Deterministic test for brain reliability: the transient-error classifier and
 * the retry-with-backoff wrapper (injected no-op sleep → no real delay).
 */
import { isTransientError, retry } from "../src/brain/provider.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const noSleep = async () => {};

// ---- classifier -------------------------------------------------------------
check("5xx is transient", isTransientError(new Error("local LLM 503: loading model")));
check("429 is transient", isTransientError(new Error("local LLM 429: slow down")));
check("connection refused is transient", isTransientError(new Error("fetch failed")));
check("ECONNREFUSED is transient", isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:1234")));
check("timeout is transient", isTransientError(new Error("request timeout")));
check("4xx is NOT transient", !isTransientError(new Error("local LLM 400: bad request")));
check("a logic error is NOT transient", !isTransientError(new Error("cannot read property of undefined")));

// ---- retry success-on-first -------------------------------------------------
let calls = 0;
const okFirst = await retry(
  async () => {
    calls++;
    return "ok";
  },
  { retries: 3, baseMs: 1 },
  noSleep,
);
check("returns the value", okFirst === "ok");
check("no retry when it succeeds first", calls === 1);

// ---- retry recovers after transient failures --------------------------------
calls = 0;
const recovered = await retry(
  async () => {
    calls++;
    if (calls < 3) throw new Error("fetch failed");
    return "recovered";
  },
  { retries: 3, baseMs: 1 },
  noSleep,
);
check("recovers after 2 transient failures", recovered === "recovered");
check("called exactly 3 times (1 + 2 retries)", calls === 3);

// ---- non-transient throws immediately ---------------------------------------
calls = 0;
let threwFast = false;
try {
  await retry(
    async () => {
      calls++;
      throw new Error("local LLM 400: bad request");
    },
    { retries: 5, baseMs: 1 },
    noSleep,
  );
} catch {
  threwFast = true;
}
check("non-transient error throws", threwFast);
check("non-transient is NOT retried", calls === 1);

// ---- exhausts retries then throws the last error ----------------------------
calls = 0;
let exhausted = false;
try {
  await retry(
    async () => {
      calls++;
      throw new Error("fetch failed");
    },
    { retries: 2, baseMs: 1 },
    noSleep,
  );
} catch (e) {
  exhausted = e instanceof Error && e.message === "fetch failed";
}
check("throws after exhausting retries", exhausted);
check("tried retries+1 times", calls === 3);

console.log(`\n[reliability] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
