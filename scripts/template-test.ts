/**
 * Deterministic tests for session templates (reusable presets). CRUD on
 * `cfg.templates`, "save session as template", field cleaning, and config.json
 * round-trip. Redirects AGI_CONFIG to a scratch file FIRST so persist() never
 * touches the real config.json.
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { Supervisor } from "../src/server/supervisor.js";
import { loadConfig, saveConfig } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\template-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const CFG = `${ROOT}\\config.json`;
// saveConfig()/persist() read AGI_CONFIG at CALL time — set it before any save
// so the test writes HERE, never the real config.json.
process.env.AGI_CONFIG = CFG;

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b" },
  limits: { maxTurns: 50, maxWallClockMin: 720, pingPongThreshold: 5, stuckTurns: 5 },
  sessions: [{ id: "s1", cwd: ROOT, goal: "do the thing", doneCriteria: "it is done" }],
};
const sup = new Supervisor(cfg, undefined, undefined, () => new Promise<void>(() => {}));

// ── 1. create ───────────────────────────────────────────────────────────────
const tpl = sup.saveTemplate({
  name: "Bug-fix sprint",
  description: "Triage and fix open bugs",
  goal: "Fix all failing tests in the repo.",
  doneCriteria: "The full test suite passes.",
  permissionMode: "auto",
  autonomy: "autonomous",
  startMode: "autopilot",
});
check("saveTemplate returns an id + timestamps", !!tpl.id && tpl.createdAt > 0 && tpl.updatedAt > 0);
check("listTemplates has the new template", sup.listTemplates().length === 1);
check("template fields persisted", tpl.name === "Bug-fix sprint" && tpl.permissionMode === "auto" && tpl.autonomy === "autonomous");

// ── 2. validation + field cleaning ───────────────────────────────────────────
let noName = false;
try {
  sup.saveTemplate({ name: "   " });
} catch {
  noName = true;
}
check("blank name is rejected", noName);
const cleaned = sup.saveTemplate({ name: "Sparse", description: "   ", goal: "" });
check("whitespace/empty optional fields clean to undefined", cleaned.description === undefined && cleaned.goal === undefined);

// ── 3. update by id (no duplicate) ───────────────────────────────────────────
const updated = sup.saveTemplate({ id: tpl.id, name: "Bug-fix sprint v2", goal: "Fix P0 bugs only." });
check("update reuses the same id", updated.id === tpl.id);
check("update does not create a duplicate", sup.listTemplates().filter((t) => t.id === tpl.id).length === 1);
check("update changes the field", updated.name === "Bug-fix sprint v2" && updated.goal === "Fix P0 bugs only.");
check("update keeps updatedAt >= createdAt", updated.updatedAt >= updated.createdAt);

// ── 4. save an existing session as a template ────────────────────────────────
const fromSess = sup.saveSessionAsTemplate("s1", "From session s1");
check("saveSessionAsTemplate captures the session goal", fromSess.goal === "do the thing");
check("saveSessionAsTemplate captures the done criteria", fromSess.doneCriteria === "it is done");
let badSess = false;
try {
  sup.saveSessionAsTemplate("nope", "x");
} catch {
  badSess = true;
}
check("saveSessionAsTemplate rejects an unknown session", badSess);

// ── 5. delete ────────────────────────────────────────────────────────────────
const before = sup.listTemplates().length;
sup.deleteTemplate(tpl.id);
check("deleteTemplate removes one", sup.listTemplates().length === before - 1);
sup.deleteTemplate("does-not-exist"); // no-op, no throw
check("deleting a missing id is a no-op", sup.listTemplates().length === before - 1);

// ── 6. config.json round-trip (persist → loadConfig) ─────────────────────────
// persist() writes are fire-and-forget; await one explicit save to flush the
// serialized write chain before reading the file back.
await saveConfig(cfg);
const reloaded = await loadConfig(CFG);
check("templates survive a save→load round-trip", (reloaded.templates?.length ?? 0) === sup.listTemplates().length);
check("round-tripped template keeps its name", reloaded.templates?.some((t) => t.name === "From session s1") ?? false);

// sortedness: most-recently-updated first
const list = sup.listTemplates();
check("listTemplates is sorted newest-updated first", list.every((t, i) => i === 0 || list[i - 1]!.updatedAt >= t.updatedAt));

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[template] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
