/**
 * Config loading. Reads ./config.json (or $AGI_CONFIG), fills defaults, and
 * validates the essentials. See config.example.json for the shape.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, Limits } from "./types.js";

const DEFAULT_LIMITS: Limits = {
  maxTurns: 25,
  maxWallClockMin: 60,
  pingPongThreshold: 3,
  stuckTurns: 4,
};

export async function loadConfig(file = process.env.AGI_CONFIG ?? "config.json"): Promise<AppConfig> {
  const abs = path.resolve(file);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new Error(`config not found at ${abs}. Copy config.example.json to config.json and edit it.`);
  }
  const parsed = JSON.parse(raw) as Partial<AppConfig>;

  if (!parsed.provider?.baseUrl || !parsed.provider?.model) {
    throw new Error(`config.provider.baseUrl and config.provider.model are required.`);
  }
  if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
    throw new Error(`config.sessions must list at least one session.`);
  }

  const limits: Limits = { ...DEFAULT_LIMITS, ...(parsed.limits ?? {}) };

  const sessions = parsed.sessions.map((s) => {
    if (!s.cwd || !s.goal || !s.doneCriteria) {
      throw new Error(`each session needs cwd, goal, and doneCriteria. Offender: ${JSON.stringify(s)}`);
    }
    return {
      ...s, // preserve optional fields (autonomy, gatePolicy, startMode, …)
      id: s.id || randomUUID(),
      cwd: path.resolve(s.cwd),
      goal: s.goal,
      doneCriteria: s.doneCriteria,
      permissionMode: s.permissionMode ?? "acceptEdits",
      limits: s.limits,
    };
  });

  return {
    provider: { temperature: 0.3, apiKey: "local", ...parsed.provider },
    limits,
    sessions,
    port: parsed.port ?? 4317,
    dbPath: path.resolve(parsed.dbPath ?? process.env.AGI_DB ?? "agi.db"),
    budget: parsed.budget,
    maxConcurrent: parsed.maxConcurrent,
    defaults: parsed.defaults,
    contextGuard: parsed.contextGuard,
    learning: parsed.learning,
    dispatch: parsed.dispatch,
  };
}

/**
 * Persist the live AppConfig back to the same path loadConfig reads (default
 * ./config.json or $AGI_CONFIG), pretty-printed (2-space JSON). Writes the live
 * AppConfig shape (provider, limits, sessions, port); any `_notes` field from
 * config.example is intentionally not preserved.
 */
export async function saveConfig(
  cfg: AppConfig,
  file = process.env.AGI_CONFIG ?? "config.json",
): Promise<void> {
  const abs = path.resolve(file);
  const out: AppConfig = {
    provider: cfg.provider,
    limits: cfg.limits,
    sessions: cfg.sessions,
    port: cfg.port,
    dbPath: cfg.dbPath,
    budget: cfg.budget,
    maxConcurrent: cfg.maxConcurrent,
    defaults: cfg.defaults,
    contextGuard: cfg.contextGuard,
    learning: cfg.learning,
    dispatch: cfg.dispatch,
  };
  await writeFile(abs, JSON.stringify(out, null, 2) + "\n", "utf8");
}
