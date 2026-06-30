/**
 * Deterministic test: the Supervisor rejects out-of-range enum values on
 * addSession / updateSession. These fields (permissionMode, autonomy, startMode)
 * flow into the pty spawn and brain persona, so a bad value must throw — not be
 * silently persisted. Valid values must still be accepted.
 */
import { Supervisor } from "../src/server/supervisor.js";
import type { AppConfig } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};
const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "local", temperature: 0.3 },
  limits: { maxTurns: 5, maxWallClockMin: 10, pingPongThreshold: 3, stuckTurns: 4 },
  sessions: [
    { id: "s1", cwd: "C:\\tmp\\v", goal: "g", doneCriteria: "d", permissionMode: "acceptEdits" },
  ],
};

const sup = new Supervisor(cfg, undefined, undefined, () => new Promise<void>(() => {}));

// --- addSession enum rejection ---
check("addSession rejects bad permissionMode", throws(() =>
  sup.addSession({ cwd: "C:\\tmp\\a", goal: "g", doneCriteria: "d", permissionMode: "yolo" as never })));
check("addSession rejects bad autonomy", throws(() =>
  sup.addSession({ cwd: "C:\\tmp\\b", goal: "g", doneCriteria: "d", autonomy: "reckless" as never })));
check("addSession rejects bad startMode", throws(() =>
  sup.addSession({ cwd: "C:\\tmp\\c", goal: "g", doneCriteria: "d", startMode: "turbo" as never })));

// A bad enum must NOT have created the session.
check("rejected adds did not persist", sup.list().length === 1);

// --- addSession accepts valid enums ---
let added = false;
try {
  sup.addSession({
    cwd: "C:\\tmp\\ok",
    goal: "g",
    doneCriteria: "d",
    permissionMode: "bypassPermissions",
    autonomy: "autonomous",
    startMode: "manual",
  });
  added = true;
} catch {
  added = false;
}
check("addSession accepts valid enums", added && sup.list().length === 2);

// --- updateSession enum rejection / acceptance (s1 is idle, fully editable) ---
check("updateSession rejects bad permissionMode", throws(() =>
  sup.updateSession("s1", { permissionMode: "nope" as never })));
check("updateSession rejects bad autonomy", throws(() =>
  sup.updateSession("s1", { autonomy: "wild" as never })));

let updated = false;
try {
  sup.updateSession("s1", { autonomy: "cautious", startMode: "autopilot" });
  updated = true;
} catch {
  updated = false;
}
const s1 = sup.list().find((s) => s.id === "s1");
check("updateSession accepts valid enums", updated && s1?.autonomy === "cautious");

console.log(`\n[validation] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
