/**
 * Reference registry server — a minimal, self-contained implementation of the
 * remote recipe protocol the orchestrator's registry CLIENT (./client.ts) speaks:
 *
 *   GET  /recipes  → { "recipes": RemoteRecipe[] }   (browse)
 *   POST /publish  → { ok, catalogId }               (publish a recipe)
 *
 * Recipes are stored as one JSON file per recipe under a directory, so the whole
 * thing is inspectable on disk and has no database. Dependency-free (node:http +
 * node:fs), matching the rest of the project. The routing is a PURE function
 * (`routeRegistry`) over a `RegistryStore`, so it's fully unit-testable with no
 * sockets; `createRegistryServer` is the thin HTTP shell around it.
 *
 * This is a REFERENCE/self-host server — point `config.registry.url` at
 * `http://host:port/recipes` and `publishUrl` at `http://host:port/publish`.
 */
import http from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRecipe, type RemoteRecipe } from "./client.js";

/** Filesystem-backed recipe store: one `<catalogId>.json` per recipe. */
export class RegistryStore {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** All valid recipes on disk, deduped by catalogId (newest filename wins is N/A — ids are unique filenames). */
  list(): RemoteRecipe[] {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: RemoteRecipe[] = [];
    const seen = new Set<string>();
    for (const f of files.sort()) {
      try {
        const recipe = parseRecipe(JSON.parse(readFileSync(join(this.dir, f), "utf8")));
        if (recipe && !seen.has(recipe.catalogId)) {
          seen.add(recipe.catalogId);
          out.push(recipe);
        }
      } catch {
        /* skip a malformed file, never fail the whole list */
      }
    }
    return out;
  }

  /**
   * Validate + persist a recipe (create or overwrite by catalogId). Returns the
   * stored recipe, or null if the payload isn't a valid recipe.
   */
  publish(raw: unknown): RemoteRecipe | null {
    const recipe = parseRecipe(raw);
    if (!recipe) return null;
    // catalogId is already slug-shaped (parseRecipe slugs it), but harden the
    // filename against path traversal regardless.
    const safe = recipe.catalogId.replace(/[^a-z0-9._-]/gi, "-").replace(/^[.]+/, "");
    if (!safe) return null;
    writeFileSync(join(this.dir, `${safe}.json`), JSON.stringify(recipe, null, 2));
    return recipe;
  }
}

export interface RegistryRequest {
  method: string;
  /** Path WITHOUT query string (e.g. "/recipes"). */
  path: string;
  /** Raw request body (POST). */
  body?: string;
  /** Value of the Authorization header, if any. */
  authHeader?: string;
}

export interface RegistryResponse {
  status: number;
  json: unknown;
}

export interface RegistryServerOptions {
  /** Directory the recipes live in. */
  dir: string;
  /** When set, POST /publish requires `Authorization: Bearer <token>`. */
  token?: string;
}

/** Pure request router (no I/O beyond the injected store). Unit-testable. */
export function routeRegistry(
  req: RegistryRequest,
  store: RegistryStore,
  opts: { token?: string } = {},
): RegistryResponse {
  const path = req.path.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  if (method === "GET" && (path === "/recipes" || path === "/")) {
    return { status: 200, json: { recipes: store.list() } };
  }

  if (method === "POST" && path === "/publish") {
    if (opts.token && req.authHeader !== `Bearer ${opts.token}`) {
      return { status: 401, json: { ok: false, error: "unauthorized" } };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body || "");
    } catch {
      return { status: 400, json: { ok: false, error: "invalid JSON body" } };
    }
    const stored = store.publish(parsed);
    if (!stored) return { status: 400, json: { ok: false, error: "invalid recipe (a name is required)" } };
    return { status: 201, json: { ok: true, catalogId: stored.catalogId } };
  }

  return { status: 404, json: { ok: false, error: "not found" } };
}

/** Build (but don't start) the HTTP server around `routeRegistry`. */
export function createRegistryServer(opts: RegistryServerOptions): http.Server {
  const store = new RegistryStore(opts.dir);
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const result = routeRegistry(
        {
          method: req.method ?? "GET",
          path,
          body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
          authHeader: req.headers["authorization"],
        },
        store,
        { token: opts.token },
      );
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.json));
    });
    req.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "bad request" }));
      }
    });
  });
}
