/**
 * Config loading. Reads ./config.json (or $AGI_CONFIG), fills defaults, and
 * validates the essentials. See config.example.json for the shape.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, Limits } from "./types.js";

// Serializes config writes so rapid/overlapping saves (e.g. live edits + an
// onSession persist) can't interleave. Kept alive even if one write fails.
let writeChain: Promise<void> = Promise.resolve();

const DEFAULT_LIMITS: Limits = {
  maxTurns: 25,
  maxWallClockMin: 60,
  pingPongThreshold: 3,
  stuckTurns: 4,
};

/**
 * Subscription-safety / cost guard: the brain must talk to a LOCAL model server,
 * never a paid remote API. Returns true only for loopback hosts. Exported so the
 * provider check is unit-testable.
 */
export function isLoopbackEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Throw if a configured provider would reach a non-local (potentially billed) endpoint. */
function assertLocalProvider(label: string, baseUrl: string): void {
  if (!isLoopbackEndpoint(baseUrl)) {
    throw new Error(
      `config.${label}.baseUrl must be a local endpoint (localhost/127.0.0.1) to stay ` +
        `subscription-safe — refusing "${baseUrl}". The brain must never call a paid remote API.`,
    );
  }
}

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
  assertLocalProvider("provider", parsed.provider.baseUrl);
  if (parsed.escalationProvider) {
    if (!parsed.escalationProvider.baseUrl || !parsed.escalationProvider.model) {
      throw new Error(`config.escalationProvider needs both baseUrl and model (or omit it entirely).`);
    }
    assertLocalProvider("escalationProvider", parsed.escalationProvider.baseUrl);
  }
  if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
    throw new Error(`config.sessions must list at least one session.`);
  }
  const ct = parsed.brain?.confidenceThreshold;
  if (ct !== undefined && (typeof ct !== "number" || ct < 0 || ct > 1)) {
    throw new Error(`config.brain.confidenceThreshold must be a number in [0,1] (got ${ct}).`);
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
    escalationProvider: parsed.escalationProvider
      ? { temperature: 0.3, apiKey: "local", ...parsed.escalationProvider }
      : undefined,
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
    usageGuard: parsed.usageGuard,
    brain: parsed.brain,
    templates: Array.isArray(parsed.templates) ? parsed.templates : undefined,
    webhooks: Array.isArray(parsed.webhooks) ? parsed.webhooks : undefined,
    reliability: parsed.reliability,
    logging: parsed.logging,
    registry: parsed.registry,
    automations: Array.isArray(parsed.automations) ? parsed.automations : undefined,
    quietHours: parsed.quietHours,
    automationChainCap: typeof parsed.automationChainCap === "number" ? parsed.automationChainCap : undefined,
    workflowDepthCap: typeof parsed.workflowDepthCap === "number" ? parsed.workflowDepthCap : undefined,
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
    escalationProvider: cfg.escalationProvider,
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
    usageGuard: cfg.usageGuard,
    brain: cfg.brain,
    templates: cfg.templates,
    webhooks: cfg.webhooks,
    reliability: cfg.reliability,
    logging: cfg.logging,
    registry: cfg.registry,
    automations: cfg.automations,
    quietHours: cfg.quietHours,
    automationChainCap: cfg.automationChainCap,
    workflowDepthCap: cfg.workflowDepthCap,
  };
  const json = JSON.stringify(out, null, 2) + "\n";
  // Write atomically (temp file + rename) so a crash or an interleaved write can
  // never leave a half-written, unparseable config.json; serialize via writeChain.
  const run = async (): Promise<void> => {
    const tmp = `${abs}.tmp`;
    await writeFile(tmp, json, "utf8");
    await rename(tmp, abs);
  };
  const result = writeChain.then(run, run);
  writeChain = result.catch(() => {}); // a failed write must not poison later saves
  return result;
}
