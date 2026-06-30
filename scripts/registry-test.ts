/**
 * Deterministic tests for the remote template registry client. All HTTP is a
 * stub FetchLike — no network. Covers parsing/validation, opt-in gating, and the
 * fail-soft fetch/publish paths (never throw).
 */
import {
  parseRecipe,
  parseRegistryResponse,
  canBrowse,
  canPublish,
  fetchRegistry,
  publishRecipe,
  recipeFromTemplate,
  type FetchLike,
} from "../src/registry/client.js";
import type { RegistryOptions, SessionTemplate } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// A stub fetch that records the last call and returns a scripted response.
function stub(response: { ok: boolean; status: number; body: string }): {
  fn: FetchLike;
  calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }>;
} {
  const calls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: response.ok, status: response.status, text: async () => response.body };
  };
  return { fn, calls };
}

// ── 1. parseRecipe ────────────────────────────────────────────────────────────
check("parseRecipe rejects non-objects", parseRecipe("nope") === null && parseRecipe(null) === null);
check("parseRecipe requires a name", parseRecipe({ goal: "x" }) === null);
const slugged = parseRecipe({ name: "My Cool Recipe" });
check("parseRecipe slugs a missing catalogId", slugged?.catalogId === "my-cool-recipe");
const coerced = parseRecipe({ name: "X", catalogId: "x", permissionMode: "bogus", autonomy: "balanced", startMode: "weird" });
check("parseRecipe drops invalid enum values", coerced?.permissionMode === undefined && coerced?.startMode === undefined);
check("parseRecipe keeps valid enum values", coerced?.autonomy === "balanced");

// ── 2. parseRegistryResponse ──────────────────────────────────────────────────
const arr = parseRegistryResponse(JSON.stringify([{ name: "A" }, { name: "B" }, { bad: true }]));
check("parses a bare array, drops malformed", arr.length === 2);
const wrapped = parseRegistryResponse(JSON.stringify({ recipes: [{ name: "A", catalogId: "a" }] }));
check("parses a {recipes:[…]} envelope", wrapped.length === 1 && wrapped[0]!.catalogId === "a");
const dups = parseRegistryResponse(JSON.stringify([{ name: "A", catalogId: "x" }, { name: "B", catalogId: "x" }]));
check("collapses duplicate catalogIds (first wins)", dups.length === 1 && dups[0]!.name === "A");
check("invalid JSON → empty list", parseRegistryResponse("{not json").length === 0);

// ── 3. gating (opt-in) ────────────────────────────────────────────────────────
check("canBrowse false when no url", !canBrowse(undefined) && !canBrowse({}));
check("canBrowse requires http(s)", !canBrowse({ url: "ftp://x" }) && canBrowse({ url: "https://x/r.json" }));
check("canPublish false when no publishUrl", !canPublish({ url: "https://x" }));
check("canPublish requires http(s)", canPublish({ publishUrl: "https://x/pub" }));

// ── 4. fetchRegistry (fail-soft) ──────────────────────────────────────────────
const disabled = await fetchRegistry(undefined, stub({ ok: true, status: 200, body: "[]" }).fn);
check("fetch disabled when unconfigured", disabled.ok === false && disabled.recipes.length === 0);

const okCfg: RegistryOptions = { url: "https://reg.example/recipes.json", token: "secret" };
const okStub = stub({ ok: true, status: 200, body: JSON.stringify([{ name: "Shared recipe", catalogId: "shared" }]) });
const fetched = await fetchRegistry(okCfg, okStub.fn);
check("fetch ok returns recipes", fetched.ok === true && fetched.recipes[0]?.catalogId === "shared");
check("fetch sends the bearer token", okStub.calls[0]?.init?.headers?.Authorization === "Bearer secret");
check("fetch uses GET", okStub.calls[0]?.init?.method === "GET");

const errFetch = await fetchRegistry(okCfg, stub({ ok: false, status: 503, body: "" }).fn);
check("non-2xx fetch fails soft with status", errFetch.ok === false && /503/.test(errFetch.error ?? ""));

const throwFetch = await fetchRegistry(okCfg, async () => {
  throw new Error("network down");
});
check("a thrown fetch is caught, not propagated", throwFetch.ok === false && /network down/.test(throwFetch.error ?? ""));

// ── 5. publishRecipe ──────────────────────────────────────────────────────────
const tpl: SessionTemplate = {
  id: "t1", name: "My recipe", goal: "do x", doneCriteria: "x done",
  permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot",
  catalogId: "my-recipe", createdAt: 1, updatedAt: 2,
};
const recipe = recipeFromTemplate(tpl);
check("recipeFromTemplate strips ids/timestamps", !("id" in recipe) && !("createdAt" in recipe) && recipe.name === "My recipe");

const noPub = await publishRecipe({ url: "https://x" }, recipe, stub({ ok: true, status: 200, body: "{}" }).fn);
check("publish disabled when no publishUrl", noPub.ok === false);

const pubStub = stub({ ok: true, status: 201, body: JSON.stringify({ url: "https://reg.example/r/my-recipe" }) });
const published = await publishRecipe({ publishUrl: "https://reg.example/publish", token: "tok" }, recipe, pubStub.fn);
check("publish ok returns the recipe url", published.ok === true && published.url === "https://reg.example/r/my-recipe");
check("publish POSTs the recipe body", pubStub.calls[0]?.init?.method === "POST" && (pubStub.calls[0]?.init?.body ?? "").includes("My recipe"));
check("publish sends the bearer token", pubStub.calls[0]?.init?.headers?.Authorization === "Bearer tok");

const pubNoBody = await publishRecipe({ publishUrl: "https://reg.example/publish" }, recipe, stub({ ok: true, status: 204, body: "" }).fn);
check("publish tolerates an empty/non-JSON body", pubNoBody.ok === true && pubNoBody.url === undefined);

const pubErr = await publishRecipe({ publishUrl: "https://reg.example/publish" }, recipe, stub({ ok: false, status: 401, body: "" }).fn);
check("publish failure fails soft with status", pubErr.ok === false && /401/.test(pubErr.error ?? ""));

console.log(`\n[registry] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
