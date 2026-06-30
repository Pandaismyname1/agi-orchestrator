/**
 * Deterministic test for live editing a RUNNING session (issue E). Uses a stub
 * runner that never resolves so the session stays "running", then asserts:
 *  - goal / doneCriteria / autonomy edits apply live (mutate config + view),
 *  - cwd and permissionMode edits are rejected while running (fixed at launch).
 */
import { Supervisor } from "../src/server/supervisor.js";
import type { AppConfig } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "local", temperature: 0.3 },
  limits: { maxTurns: 5, maxWallClockMin: 10, pingPongThreshold: 3, stuckTurns: 4 },
  sessions: [
    {
      id: "s1",
      cwd: "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\live-edit",
      goal: "old goal",
      doneCriteria: "old done",
      permissionMode: "acceptEdits",
      autonomy: "balanced",
    },
  ],
};

// Never-resolving runner → the launched session stays "running".
const sup = new Supervisor(cfg, undefined, undefined, () => new Promise<void>(() => {}));

sup.start("s1");
const running = sup.list().find((s) => s.id === "s1");
check("session is running after start", running?.status === "running");

// Live edits to goal / doneCriteria / autonomy.
const v = sup.updateSession("s1", { goal: "new goal", doneCriteria: "new done", autonomy: "autonomous" });
check("updateSession does not throw while running", true);
check("goal applied live (view)", v.goal === "new goal");
check("doneCriteria applied live (view)", v.doneCriteria === "new done");
check("autonomy applied live (view)", v.autonomy === "autonomous");

// The brain reads m.config by reference — confirm the underlying config changed too.
const after = sup.list().find((s) => s.id === "s1");
check("goal reflected in fresh snapshot", after?.goal === "new goal");

// cwd + permissionMode are fixed at launch → rejected while running.
let threwCwd = false;
try {
  sup.updateSession("s1", { cwd: "C:\\somewhere\\else" });
} catch {
  threwCwd = true;
}
check("changing cwd while running is rejected", threwCwd);

let threwPerm = false;
try {
  sup.updateSession("s1", { permissionMode: "bypassPermissions" });
} catch {
  threwPerm = true;
}
check("changing permissionMode while running is rejected", threwPerm);

// Same-value cwd/permissionMode is a no-op, not a rejection.
let sameOk = true;
try {
  sup.updateSession("s1", { cwd: "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\live-edit", permissionMode: "acceptEdits" });
} catch {
  sameOk = false;
}
check("re-sending unchanged cwd/permissionMode is allowed", sameOk);

console.log(`\n[live-edit] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
