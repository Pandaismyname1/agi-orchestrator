/**
 * Environment hygiene for spawned claude processes.
 *
 * Two jobs:
 *  1. preflight() — HARD ABORT if anything in the environment would route usage
 *     through the pay-per-token API instead of the subscription. This is the
 *     core billing safety guarantee of the whole project.
 *  2. scrubbedEnv() — strip parent-Claude-session vars so a spawned claude.exe
 *     launches as if from a clean terminal (avoids nested-session auth weirdness)
 *     and can NEVER inherit an API key.
 */

/** Env vars that force API billing or otherwise hijack auth. Their presence aborts startup. */
const BILLING_TRAP_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
];

export class BillingSafetyError extends Error {}

/**
 * Abort hard if the environment would cause API (pay-per-token) billing.
 * Call once at daemon startup, before spawning anything.
 */
export function preflight(env: NodeJS.ProcessEnv = process.env): void {
  const offenders = BILLING_TRAP_VARS.filter((k) => {
    const v = env[k];
    return v != null && v !== "";
  });
  if (offenders.length > 0) {
    throw new BillingSafetyError(
      `Refusing to start: these env vars would route usage through the pay-per-token API ` +
        `instead of your subscription:\n  ${offenders.join("\n  ")}\n` +
        `Unset them and restart. (This guard exists so an automated loop can never silently bill you.)`,
    );
  }
  // A custom base URL pointed somewhere other than the official endpoint is also suspicious.
  const base = env.ANTHROPIC_BASE_URL;
  if (base && !/^https:\/\/api\.anthropic\.com\/?$/.test(base)) {
    throw new BillingSafetyError(
      `Refusing to start: ANTHROPIC_BASE_URL is set to "${base}". ` +
        `Unset it to use the normal subscription endpoint.`,
    );
  }
}

/** True for env vars injected by a parent Claude Code/Desktop session. */
function isParentSessionVar(key: string): boolean {
  return (
    /^CLAUDE(CODE)?($|_)/i.test(key) ||
    key === "AI_AGENT" ||
    key === "BAGGAGE" ||
    key === "API_TIMEOUT_MS"
  );
}

/**
 * A clean environment for spawning claude.exe: drops parent-session vars and any
 * billing-trap vars. The spawned CLI then authenticates via the user's normal
 * cached subscription credentials.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (isParentSessionVar(k)) continue;
    if (BILLING_TRAP_VARS.includes(k)) continue;
    if (k === "ANTHROPIC_BASE_URL") continue;
    out[k] = v;
  }
  return out;
}
