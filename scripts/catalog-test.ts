/**
 * Deterministic tests for the starter-template catalog ("marketplace" foundation).
 * Validates the built-in recipe data, the installed-flag annotation, and the
 * Supervisor install path (idempotent, sets catalogId, survives config round-trip).
 * Redirects AGI_CONFIG to a scratch file FIRST so persist() never touches the real one.
 */
import { mkdirSync, rmSync } from "node:fs";
import { Supervisor } from "../src/server/supervisor.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { STARTER_TEMPLATES, catalogWithInstalled, findCatalogTemplate } from "../src/policy/catalog.js";
import type { AppConfig } from "../src/types.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\catalog-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const CFG = `${ROOT}\\config.json`;
process.env.AGI_CONFIG = CFG;

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── 1. catalog data integrity ────────────────────────────────────────────────
check("catalog is non-empty", STARTER_TEMPLATES.length >= 5);
check("every entry has the required fields", STARTER_TEMPLATES.every(
  (t) => !!t.catalogId && !!t.name && !!t.goal && !!t.doneCriteria && !!t.permissionMode && !!t.autonomy && !!t.startMode,
));
const ids = STARTER_TEMPLATES.map((t) => t.catalogId);
check("catalogIds are unique", new Set(ids).size === ids.length);
check("findCatalogTemplate resolves a known id", findCatalogTemplate("bugfix-sprint")?.name === "Bug-fix sprint");
check("findCatalogTemplate returns undefined for unknown", findCatalogTemplate("nope") === undefined);

// ── 2. catalogWithInstalled flags ────────────────────────────────────────────
const none = catalogWithInstalled([]);
check("nothing installed → all installed:false", none.every((e) => e.installed === false));
const withOne = catalogWithInstalled([
  { id: "x", name: "X", catalogId: "bugfix-sprint", createdAt: 0, updatedAt: 0 },
]);
check("a matching catalogId flips installed:true for that entry", withOne.find((e) => e.catalogId === "bugfix-sprint")?.installed === true);
check("non-matching entries stay installed:false", withOne.filter((e) => e.catalogId !== "bugfix-sprint").every((e) => !e.installed));

// ── 3. Supervisor install path ───────────────────────────────────────────────
const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b" },
  limits: { maxTurns: 50, maxWallClockMin: 720, pingPongThreshold: 5, stuckTurns: 5 },
  sessions: [{ id: "s1", cwd: ROOT, goal: "g", doneCriteria: "d" }],
};
const sup = new Supervisor(cfg, undefined, undefined, () => new Promise<void>(() => {}));

check("listCatalog initially shows nothing installed", sup.listCatalog().every((e) => !e.installed));

const installed = sup.installCatalogTemplate("bugfix-sprint");
check("install returns a real template with an id", !!installed.id && installed.createdAt > 0);
check("installed template carries the catalogId", installed.catalogId === "bugfix-sprint");
check("installed template copied the recipe goal", installed.goal === findCatalogTemplate("bugfix-sprint")!.goal);
check("it now appears in listTemplates", sup.listTemplates().some((t) => t.id === installed.id));
check("listCatalog now flags bugfix-sprint installed", sup.listCatalog().find((e) => e.catalogId === "bugfix-sprint")?.installed === true);

// idempotent: a second install returns the SAME template, no duplicate.
const again = sup.installCatalogTemplate("bugfix-sprint");
check("re-install is idempotent (same id)", again.id === installed.id);
check("re-install does not duplicate", sup.listTemplates().filter((t) => t.catalogId === "bugfix-sprint").length === 1);

// unknown catalog id throws.
let threw = false;
try {
  sup.installCatalogTemplate("does-not-exist");
} catch {
  threw = true;
}
check("installing an unknown catalog id throws", threw);

// installed template is fully editable afterwards (no catalog lock-in).
const edited = sup.saveTemplate({ id: installed.id, name: "My customized sprint" });
check("installed template is editable", edited.name === "My customized sprint" && edited.id === installed.id);

// ── 4. config round-trip keeps catalogId ─────────────────────────────────────
await saveConfig(cfg);
const reloaded = await loadConfig(CFG);
check("catalogId survives a save→load round-trip", reloaded.templates?.some((t) => t.catalogId === "bugfix-sprint") ?? false);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[catalog] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
