/**
 * Remote template registry client — the network layer of the agent marketplace.
 *
 * Lets the operator BROWSE community recipes from an external source and PUBLISH
 * their own. Entirely opt-in: with no configured URL it's inert (no phone-home),
 * and it carries ONLY template data — it never touches the local-only decision
 * brain, so the subscription-safety guarantee is unaffected.
 *
 * The HTTP call is injected (`FetchLike`) so every code path is unit-testable
 * with no network, mirroring the runner-injection pattern used elsewhere. All
 * functions FAIL SOFT — they return an {ok,...} result and never throw.
 */
import type { RegistryOptions, SessionConfig, SessionTemplate } from "../types.js";

/** A recipe as it travels over the wire (catalog shape + provenance metadata). */
export interface RemoteRecipe {
  /** Stable slug identifying the recipe in the registry. */
  catalogId: string;
  name: string;
  description?: string;
  goal?: string;
  doneCriteria?: string;
  permissionMode?: SessionConfig["permissionMode"];
  autonomy?: SessionConfig["autonomy"];
  startMode?: SessionConfig["startMode"];
  /** Optional provenance shown in the UI. */
  author?: string;
  version?: string;
}

/** Minimal fetch shape (the global `fetch`'s Response satisfies this). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface FetchResult {
  ok: boolean;
  recipes: RemoteRecipe[];
  error?: string;
}

export interface PublishResult {
  ok: boolean;
  /** A URL the registry returned for the published recipe, if any. */
  url?: string;
  error?: string;
}

const PERMISSION_MODES = new Set(["default", "acceptEdits", "auto", "bypassPermissions"]);
const AUTONOMIES = new Set(["cautious", "balanced", "autonomous"]);
const START_MODES = new Set(["manual", "autopilot"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function enumOf<T extends string>(v: unknown, allowed: Set<string>): T | undefined {
  const s = str(v);
  return s && allowed.has(s) ? (s as T) : undefined;
}

/** Coerce one wire object into a RemoteRecipe, or null if it lacks the essentials. */
export function parseRecipe(o: unknown): RemoteRecipe | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const name = str(r.name);
  if (!name) return null;
  // catalogId defaults to a slug of the name so older/looser sources still work.
  const catalogId = str(r.catalogId) ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!catalogId) return null;
  return {
    catalogId,
    name,
    description: str(r.description),
    goal: str(r.goal),
    doneCriteria: str(r.doneCriteria),
    permissionMode: enumOf(r.permissionMode, PERMISSION_MODES),
    autonomy: enumOf(r.autonomy, AUTONOMIES),
    startMode: enumOf(r.startMode, START_MODES),
    author: str(r.author),
    version: str(r.version),
  };
}

/**
 * Parse a registry response body. Accepts either a bare JSON array or an object
 * with a `recipes` array. Malformed entries are dropped, not fatal; duplicate
 * catalogIds are collapsed (first wins).
 */
export function parseRegistryResponse(raw: string): RemoteRecipe[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>)?.recipes)
      ? ((data as Record<string, unknown>).recipes as unknown[])
      : [];
  const seen = new Set<string>();
  const out: RemoteRecipe[] = [];
  for (const item of arr) {
    const recipe = parseRecipe(item);
    if (recipe && !seen.has(recipe.catalogId)) {
      seen.add(recipe.catalogId);
      out.push(recipe);
    }
  }
  return out;
}

/** True when browsing is enabled (a registry url is configured). */
export function canBrowse(cfg: RegistryOptions | undefined): boolean {
  return !!str(cfg?.url) && /^https?:\/\//i.test(cfg!.url!);
}
/** True when publishing is enabled (a publish url is configured). */
export function canPublish(cfg: RegistryOptions | undefined): boolean {
  return !!str(cfg?.publishUrl) && /^https?:\/\//i.test(cfg!.publishUrl!);
}

function authHeaders(cfg: RegistryOptions | undefined): Record<string, string> {
  const token = str(cfg?.token);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Fetch the community recipe list. Returns {ok:false} (never throws) on any failure. */
export async function fetchRegistry(
  cfg: RegistryOptions | undefined,
  fetchFn: FetchLike,
): Promise<FetchResult> {
  if (!canBrowse(cfg)) return { ok: false, recipes: [], error: "registry browsing is not configured" };
  try {
    const res = await fetchFn(cfg!.url!, { method: "GET", headers: { Accept: "application/json", ...authHeaders(cfg) } });
    if (!res.ok) return { ok: false, recipes: [], error: `registry responded ${res.status}` };
    return { ok: true, recipes: parseRegistryResponse(await res.text()) };
  } catch (e) {
    return { ok: false, recipes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Build the publishable recipe payload from a local template (drops ids/timestamps). */
export function recipeFromTemplate(t: SessionTemplate): RemoteRecipe {
  return {
    catalogId: t.catalogId ?? t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    name: t.name,
    description: t.description,
    goal: t.goal,
    doneCriteria: t.doneCriteria,
    permissionMode: t.permissionMode,
    autonomy: t.autonomy,
    startMode: t.startMode,
  };
}

/** Publish a recipe to the configured publish URL. Returns {ok:false} on any failure. */
export async function publishRecipe(
  cfg: RegistryOptions | undefined,
  recipe: RemoteRecipe,
  fetchFn: FetchLike,
): Promise<PublishResult> {
  if (!canPublish(cfg)) return { ok: false, error: "registry publishing is not configured" };
  try {
    const res = await fetchFn(cfg!.publishUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders(cfg) },
      body: JSON.stringify(recipe),
    });
    if (!res.ok) return { ok: false, error: `registry responded ${res.status}` };
    // A url in the response body is optional; tolerate a non-JSON body.
    let url: string | undefined;
    try {
      const body = JSON.parse(await res.text()) as Record<string, unknown>;
      url = str(body.url) ?? str(body.html_url);
    } catch {
      /* no body / not JSON — still a success */
    }
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
