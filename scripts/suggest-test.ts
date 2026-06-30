/**
 * Deterministic test for goal-intake suggestions (no LLM): suggestTemplates ranks
 * templates by keyword overlap with the goal, and suggestDependsOn proposes
 * same-project sessions the new one should run after (downstream→upstream verb
 * pairing + keyword overlap). Pure functions over in-memory inputs.
 */
import { suggestTemplates, suggestDependsOn, tokenize } from "../src/policy/suggest.js";
import type { SessionTemplate } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const mkTmpl = (id: string, name: string, goal?: string, description?: string): SessionTemplate => ({
  id, name, goal, description, createdAt: 0, updatedAt: 0,
});

// --- tokenize drops stopwords + short tokens ---------------------------------
const toks = tokenize("Build the marketing website for my coffee shop");
check("tokenize drops stopwords/short words", !toks.includes("the") && !toks.includes("for"));
check("tokenize keeps meaningful words", toks.includes("marketing") && toks.includes("website") && toks.includes("coffee"));

// --- suggestTemplates --------------------------------------------------------
const templates = [
  mkTmpl("tpl-bug", "Bug-fix sprint", "Find and fix failing tests and open bugs.", "triage bugs"),
  mkTmpl("tpl-audit", "Security audit", "Audit the codebase for vulnerabilities.", "security review"),
  mkTmpl("tpl-docs", "Docs polish", "Improve the README and docs.", "documentation"),
];

const tSug = suggestTemplates("fix the failing tests and remaining bugs", templates, 3);
check("template suggestions returned", tSug.length >= 1);
check("best template is the bug-fix sprint", tSug[0]?.id === "tpl-bug");
check("suggestion carries a reason", (tSug[0]?.reason ?? "").startsWith("matches:"));
check("unrelated template excluded or ranked below", tSug[0]!.score > (tSug.find((s) => s.id === "tpl-docs")?.score ?? 0));

const noMatch = suggestTemplates("xyzzy frobnicate", templates, 3);
check("no keyword overlap → no template suggestions", noMatch.length === 0);

const emptyGoal = suggestTemplates("   ", templates, 3);
check("empty goal → no suggestions", emptyGoal.length === 0);

// --- suggestDependsOn --------------------------------------------------------
const sessions = [
  { id: "build-site", goal: "Build the one-page coffee shop website", cwd: "C:\\proj\\site" },
  { id: "deploy-old", goal: "Deploy something unrelated", cwd: "C:\\other" },
  { id: "write-tests", goal: "Write unit tests for the site", cwd: "C:\\proj\\site" },
];

// A deploy goal in the same project as a build session → build is the top dep.
const dSug = suggestDependsOn(
  { cwd: "C:\\proj\\site", goal: "Deploy the finished coffee shop website to GitHub Pages" },
  sessions,
  3,
);
check("dependsOn suggestions returned", dSug.length >= 1);
check("top dependsOn is the same-project build step", dSug[0]?.id === "build-site");
check("cross-project session is excluded", !dSug.some((d) => d.id === "deploy-old"));
check("verb-pairing reason is explained", (dSug[0]?.reason ?? "").includes("runs after"));
check("dependsOn label is the candidate goal", (dSug[0]?.label ?? "").startsWith("Build the one-page"));

// excludeId removes a candidate (editing itself).
const excluded = suggestDependsOn(
  { cwd: "C:\\proj\\site", goal: "Deploy the site", excludeId: "build-site" },
  sessions,
  3,
);
check("excludeId removes that candidate", !excluded.some((d) => d.id === "build-site"));

// No cwd → no dependency suggestions (nothing to match against).
const noCwd = suggestDependsOn({ goal: "Deploy the site" }, sessions, 3);
check("no cwd → no dependsOn suggestions", noCwd.length === 0);

// Path matching is case-insensitive / trailing-slash-insensitive.
const casey = suggestDependsOn(
  { cwd: "c:\\proj\\site\\", goal: "Deploy the coffee site" },
  sessions,
  3,
);
check("path match is case/slash-insensitive", casey.some((d) => d.id === "build-site"));

console.log(`\n[suggest] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
