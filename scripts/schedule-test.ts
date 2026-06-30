/**
 * Deterministic test for session scheduling (automation suite):
 *  - parseHHMM / lastDailyBoundary / isDue / hasActiveTrigger pure logic,
 *  - and the Supervisor's runDueSchedules() firing the right sessions through
 *    start() (and never double-firing an already-active one).
 *
 * Points AGI_CONFIG at a scratch file so persist() can't touch the real config.
 */
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agi-sched-"));
process.env.AGI_CONFIG = path.join(tmp, "config.json");

const { parseHHMM, lastDailyBoundary, isDue, hasActiveTrigger, describeSchedule } = await import(
  "../src/policy/schedule.js"
);
const { Supervisor } = await import("../src/server/supervisor.js");
import type { AppConfig } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ---- parseHHMM --------------------------------------------------------------
check("parseHHMM valid", JSON.stringify(parseHHMM("02:30")) === JSON.stringify({ h: 2, m: 30 }));
check("parseHHMM single-digit hour", JSON.stringify(parseHHMM("9:05")) === JSON.stringify({ h: 9, m: 5 }));
check("parseHHMM rejects out-of-range", parseHHMM("24:00") === null && parseHHMM("12:60") === null);
check("parseHHMM rejects junk", parseHHMM("nope") === null && parseHHMM(undefined) === null);

// ---- lastDailyBoundary ------------------------------------------------------
const now = new Date(2026, 0, 1, 3, 0, 0).getTime(); // Jan 1 2026, 03:00 local
const b2 = lastDailyBoundary(now, 2, 0); // 02:00 today (already passed)
const b4 = lastDailyBoundary(now, 4, 0); // 04:00 -> not yet today, so yesterday 04:00
check("boundary uses today when already passed", b2 === new Date(2026, 0, 1, 2, 0, 0).getTime());
check("boundary rolls to yesterday when not yet reached", b4 === new Date(2025, 11, 31, 4, 0, 0).getTime());

// ---- isDue: everyMinutes ----------------------------------------------------
check("disabled is never due", !isDue({ enabled: false, everyMinutes: 1 }, now, now - 10 * 60_000));
check("interval due after the window", isDue({ everyMinutes: 30 }, now, now - 31 * 60_000));
check("interval NOT due within the window", !isDue({ everyMinutes: 30 }, now, now - 10 * 60_000));

// ---- isDue: dailyAt ---------------------------------------------------------
const at1 = new Date(2026, 0, 1, 1, 0, 0).getTime(); // last fired 01:00
const at230 = new Date(2026, 0, 1, 2, 30, 0).getTime(); // last fired 02:30
check("daily due once we cross the time", isDue({ dailyAt: "02:00" }, now, at1));
check("daily NOT due if we already fired after it", !isDue({ dailyAt: "02:00" }, now, at230));

// ---- hasActiveTrigger / describe -------------------------------------------
check("hasActiveTrigger true for interval", hasActiveTrigger({ everyMinutes: 5 }));
check("hasActiveTrigger false when empty", !hasActiveTrigger({}));
check("hasActiveTrigger false when disabled", !hasActiveTrigger({ everyMinutes: 5, enabled: false }));
check("describe mentions both triggers", describeSchedule({ everyMinutes: 30, dailyAt: "02:00" }).includes("every 30m"));

// ---- Supervisor.runDueSchedules integration ---------------------------------
const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "local", temperature: 0.3 },
  limits: { maxTurns: 5, maxWallClockMin: 10, pingPongThreshold: 3, stuckTurns: 4 },
  sessions: [
    { id: "sched", cwd: tmp, goal: "g", doneCriteria: "d", permissionMode: "acceptEdits", schedule: { everyMinutes: 30 } },
    { id: "plain", cwd: tmp, goal: "g2", doneCriteria: "d2", permissionMode: "acceptEdits" },
    { id: "off", cwd: tmp, goal: "g3", doneCriteria: "d3", permissionMode: "acceptEdits", schedule: { everyMinutes: 1, enabled: false } },
  ],
};
// Never-resolving runner so a fired session stays "running".
const sup = new Supervisor(cfg, undefined, undefined, () => new Promise<void>(() => {}));
const status = (id: string) => sup.list().find((s) => s.id === id)?.status;

const future = Date.now() + 60 * 60_000; // an hour ahead → the interval is well past due
sup.runDueSchedules(future);
check("scheduled session auto-started", status("sched") === "running");
check("unscheduled session untouched", status("plain") === "idle");
check("disabled-schedule session untouched", status("off") === "idle");

// Firing again must not pile on / throw while it's still running.
let threw = false;
try {
  sup.runDueSchedules(future + 60 * 60_000);
} catch {
  threw = true;
}
check("re-tick never throws", !threw);
check("active session not double-started", status("sched") === "running");

// schedule is reflected in the view.
check("view exposes the schedule", sup.list().find((s) => s.id === "sched")?.schedule?.everyMinutes === 30);

console.log(`\n[schedule] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
