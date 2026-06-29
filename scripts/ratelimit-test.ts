/**
 * Deterministic unit test for rate-limit detection. Confirms it catches the
 * system usage-limit notice but NOT casual mentions of "rate limiting" in code.
 */
import { detectRateLimit } from "../src/terminal/state.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

const shouldDetect = [
  "You've reached your usage limit. Your limit resets at 3:00 PM.",
  "Approaching your usage limit — consider pausing.",
  "Usage limit reached. Upgrade to increase your usage.",
  "You're out of usage for the current window.",
  "Your usage limit will reset in 2 hours.",
  "limit resets at 9pm",
];
const shouldNOT = [
  "I'll add a rate limiter to the API endpoint.",
  "Let me configure rate limiting middleware for the server.",
  "The function's usage is documented in the README.",
  "I created index.html with all five sections.",
  "Setting a limit of 100 requests per minute in the config.",
];

for (const t of shouldDetect) check(`detect: "${t.slice(0, 40)}…"`, detectRateLimit(t) === true);
for (const t of shouldNOT) check(`ignore: "${t.slice(0, 40)}…"`, detectRateLimit(t) === false);

console.log(`\n[ratelimit] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
