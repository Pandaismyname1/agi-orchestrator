/**
 * Deterministic test for the real-usage parser + gate (src/policy/usage.ts),
 * checked against the actual `/usage` panel text captured from Claude Code.
 */
import { parseUsage, usageVerdict, parseResetAt } from "../src/policy/usage.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

// Verbatim from `npx tsx scripts/status-capture.ts`.
const REAL = `
  Current session
  ██████▌                                            13% used
  Resets 10:49am (Europe/Bucharest)

  Current week (all models)
  █████████████████▌                                 35% used
  Resets Jun 30, 10:59pm (Europe/Bucharest)

  Current week (Sonnet only)
                                                     0% used

  What's contributing to your limits usage?
  Approximate, based on local sessions on this machine
`;

// Fixed "now": Jun 30 2026, 06:30 local.
const NOW = new Date(2026, 5, 30, 6, 30, 0, 0).getTime();
const u = parseUsage(REAL, NOW);

check("session pct = 13", u.session?.pct === 13);
check("weekly all-models pct = 35", u.weeklyAll?.pct === 35);
check("weekly sonnet pct = 0", u.weeklySonnet?.pct === 0);
check("session reset text captured", u.session?.resetText === "10:49am (Europe/Bucharest)");
check("weekly reset text captured", u.weeklyAll?.resetText === "Jun 30, 10:59pm (Europe/Bucharest)");
check("sonnet window has no reset line", u.weeklySonnet?.resetText === undefined);

// Reset parsing.
check("session resets today 10:49am (future)", u.session?.resetAt === new Date(2026, 5, 30, 10, 49).getTime());
check("weekly resets Jun 30 10:59pm", u.weeklyAll?.resetAt === new Date(2026, 5, 30, 22, 59).getTime());
// Time-only already past today rolls to tomorrow.
check(
  "time-only past → tomorrow",
  parseResetAt("6:00am (X)", new Date(2026, 5, 30, 7, 0).getTime()) === new Date(2026, 6, 1, 6, 0).getTime(),
);
// On-the-hour formats (no minutes) — Claude drops ":00". Caught by the live smoke test.
check(
  "dated on-the-hour 'Jun 30, 11pm'",
  parseResetAt("Jun 30, 11pm (X)", NOW) === new Date(2026, 5, 30, 23, 0).getTime(),
);
check(
  "time-only on-the-hour '11pm'",
  parseResetAt("11pm (X)", new Date(2026, 5, 30, 13, 0).getTime()) === new Date(2026, 5, 30, 23, 0).getTime(),
);

// Gate: nothing spent → not blocked.
check("healthy usage → not blocked", usageVerdict(u).blocked === false);

// Session spent → blocked until session reset.
const sessionSpent = parseUsage(REAL.replace("13% used", "100% used"), NOW);
const v1 = usageVerdict(sessionSpent);
check("session 100% → blocked", v1.blocked === true && /session limit/.test(v1.reason));
check("session block resumes at session reset", v1.resumeAt === new Date(2026, 5, 30, 10, 49).getTime());

// Opus weekly spent, Sonnet has room → continue on Sonnet by default.
const opusSpent = parseUsage(REAL.replace("35% used", "100% used"), NOW);
const v2 = usageVerdict(opusSpent);
check("opus weekly spent, sonnet room → NOT blocked (default)", v2.blocked === false && v2.sonnetOnly === true);
check("opus weekly spent + onOpus:pause → blocked", usageVerdict(opusSpent, { onOpusExhausted: "pause" }).blocked === true);

// Both weekly pools spent → hard weekly stop. (Replace "0% used" FIRST so it
// doesn't later match the substring inside a "100% used".)
const allSpent = parseUsage(REAL.replace("0% used", "100% used").replace("35% used", "100% used"), NOW);
const v3 = usageVerdict(allSpent);
check("opus + sonnet weekly spent → blocked (weekly)", v3.blocked === true && /weekly limit/.test(v3.reason));

// Proactive threshold trips the SESSION window (13% ≥ 10%).
const v4 = usageVerdict(u, { pauseAtPercent: 10 });
check("pauseAtPercent:10 trips session at 13%", v4.blocked === true && /session limit/.test(v4.reason));

console.log(`\n[usage] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
