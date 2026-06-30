/**
 * Deterministic tests for the reference registry server. Exercises the pure
 * router + filesystem store over a temp dir (no sockets), then does ONE real
 * end-to-end round-trip: boot the HTTP server on an ephemeral port and drive it
 * with the orchestrator's own registry CLIENT (fetchRegistry/publishRecipe), so
 * client and server are proven to speak the same protocol.
 */
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RegistryStore, routeRegistry, createRegistryServer } from "../src/registry/server.js";
import { fetchRegistry, publishRecipe, recipeFromTemplate } from "../src/registry/client.js";
import type { SessionTemplate } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const dir = mkdtempSync(join(tmpdir(), "agi-reg-"));
const store = new RegistryStore(join(dir, "recipes"));

// ── 1. pure router: empty browse ─────────────────────────────────────────────
const empty = routeRegistry({ method: "GET", path: "/recipes" }, store);
check("GET /recipes is 200 with an empty list", empty.status === 200 && (empty.json as { recipes: unknown[] }).recipes.length === 0);

// ── 2. publish via router ────────────────────────────────────────────────────
const pub = routeRegistry(
  { method: "POST", path: "/publish", body: JSON.stringify({ name: "Shared Recipe", goal: "do x", doneCriteria: "x done" }) },
  store,
);
check("POST /publish is 201", pub.status === 201);
check("publish returns the slugged catalogId", (pub.json as { catalogId: string }).catalogId === "shared-recipe");
check("publish wrote a JSON file", readdirSync(join(dir, "recipes")).includes("shared-recipe.json"));

// ── 3. browse now returns it ─────────────────────────────────────────────────
const after = routeRegistry({ method: "GET", path: "/recipes" }, store);
check("GET /recipes now lists the published recipe", (after.json as { recipes: Array<{ catalogId: string }> }).recipes[0]?.catalogId === "shared-recipe");

// ── 4. validation + 404 ──────────────────────────────────────────────────────
const bad = routeRegistry({ method: "POST", path: "/publish", body: "{not json" }, store);
check("invalid JSON → 400", bad.status === 400);
const noName = routeRegistry({ method: "POST", path: "/publish", body: JSON.stringify({ goal: "x" }) }, store);
check("recipe without a name → 400", noName.status === 400);
const missing = routeRegistry({ method: "GET", path: "/nope" }, store);
check("unknown route → 404", missing.status === 404);

// ── 5. auth gating on publish ────────────────────────────────────────────────
const unauth = routeRegistry(
  { method: "POST", path: "/publish", body: JSON.stringify({ name: "X" }) },
  store,
  { token: "sek" },
);
check("publish without token → 401 when token configured", unauth.status === 401);
const authed = routeRegistry(
  { method: "POST", path: "/publish", body: JSON.stringify({ name: "X" }), authHeader: "Bearer sek" },
  store,
  { token: "sek" },
);
check("publish with correct token → 201", authed.status === 201);
const browseNoToken = routeRegistry({ method: "GET", path: "/recipes" }, store, { token: "sek" });
check("browsing stays open even with a token set", browseNoToken.status === 200);

// ── 6. end-to-end: real server ↔ real client ─────────────────────────────────
const e2eDir = join(dir, "e2e");
const server = createRegistryServer({ dir: e2eDir, token: "tok" });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
const cfg = { url: `${base}/recipes`, publishUrl: `${base}/publish`, token: "tok" };

const tpl: SessionTemplate = {
  id: "t1", name: "E2E Recipe", goal: "ship it", doneCriteria: "shipped",
  permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot",
  catalogId: "e2e-recipe", createdAt: 1, updatedAt: 1,
};

const pubRes = await publishRecipe(cfg, recipeFromTemplate(tpl), (u, init) => fetch(u, init));
check("client publishes to the live server", pubRes.ok === true);

const fetchRes = await fetchRegistry(cfg, (u, init) => fetch(u, init));
check("client fetches the published recipe back", fetchRes.ok === true && fetchRes.recipes.some((r) => r.catalogId === "e2e-recipe"));
check("round-tripped recipe keeps its goal", fetchRes.recipes.find((r) => r.catalogId === "e2e-recipe")?.goal === "ship it");

// wrong token is rejected end-to-end.
const badAuth = await publishRecipe({ ...cfg, token: "wrong" }, recipeFromTemplate(tpl), (u, init) => fetch(u, init));
check("live server rejects a wrong token", badAuth.ok === false);

await new Promise<void>((resolve) => server.close(() => resolve()));
rmSync(dir, { recursive: true, force: true });

console.log(`\n[registry-server] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
// Don't process.exit() here: undici's fetch sockets are still tearing down, and
// an abrupt exit races libuv's handle close on Windows (UV_HANDLE_CLOSING
// assertion). Set the code and let the loop drain — idle keep-alive sockets are
// unref'd, so the process exits cleanly on its own.
process.exitCode = pass ? 0 : 1;
