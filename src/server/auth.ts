/**
 * Dispatch auth — token gate for remote access to the dashboard.
 *
 * Model: loopback requests are trusted (zero local friction; the Stop-hook posts
 * locally), remote requests must present a shared token. Fail-safe: if no token is
 * configured, remote access is REFUSED — exposing the port without a token leaks
 * nothing. `trustLocal:false` forces the token even for loopback (for local tunnels
 * that make remote traffic appear to originate from 127.0.0.1).
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DispatchOptions } from "../types.js";

export interface AuthConfig {
  /** The configured secret, or "" when dispatch is disabled. */
  token: string;
  trustLocal: boolean;
}

export interface AuthResult {
  ok: boolean;
  /** True when the request came from loopback. */
  local: boolean;
  /** Why it failed (for logging / the 401 body). Absent when ok. */
  reason?: "no-token-configured" | "missing-token" | "bad-token";
}

/**
 * Resolve the effective auth config: env AGI_DISPATCH_TOKEN wins over config, and
 * an all-whitespace token counts as unset. trustLocal defaults to true.
 */
export function resolveAuthConfig(
  opts: DispatchOptions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const envToken = (env.AGI_DISPATCH_TOKEN ?? "").trim();
  const cfgToken = (opts?.token ?? "").trim();
  return {
    token: envToken || cfgToken,
    trustLocal: opts?.trustLocal !== false,
  };
}

/** Strip an IPv4-mapped IPv6 prefix so ::ffff:127.0.0.1 compares as 127.0.0.1. */
function normalizeIp(addr: string | undefined): string {
  if (!addr) return "";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

/** True when the socket's remote address is loopback. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const ip = normalizeIp(req.socket?.remoteAddress ?? undefined);
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

/**
 * Pull a presented token from a request: Authorization: Bearer, X-AGI-Token header,
 * a `token` query param (needed for the WS upgrade / initial nav), or an agi_token
 * cookie. Returns "" when none is present.
 */
export function extractToken(req: IncomingMessage): string {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1].trim();
  }
  const x = req.headers["x-agi-token"];
  if (typeof x === "string" && x.trim()) return x.trim();

  // Query param (?token=…). req.url is path+query; host is irrelevant for parsing.
  try {
    const u = new URL(req.url ?? "/", "http://localhost");
    const q = u.searchParams.get("token");
    if (q && q.trim()) return q.trim();
  } catch {
    /* malformed URL — ignore */
  }

  const cookie = req.headers["cookie"];
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const [k, ...rest] = part.split("=");
      if (k?.trim() === "agi_token") return decodeURIComponent(rest.join("=").trim());
    }
  }
  return "";
}

/** Length-independent constant-time string equality. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal length; hash both to a fixed width first so we
  // don't leak length and don't throw. Compare raw bytes when lengths already match.
  if (ba.length !== bb.length) {
    // Still do a comparison of equal-length buffers to keep timing uniform.
    const pad = Buffer.alloc(Math.max(ba.length, bb.length));
    const pa = Buffer.concat([ba, pad]).subarray(0, pad.length);
    const pb = Buffer.concat([bb, pad]).subarray(0, pad.length);
    timingSafeEqual(pa, pb);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * The core gate. Loopback + trustLocal ⇒ allowed without a token. Otherwise a
 * configured token must match the presented one (constant-time). No token
 * configured ⇒ remote is refused.
 */
export function checkAuth(req: IncomingMessage, cfg: AuthConfig): AuthResult {
  const local = isLocalRequest(req);
  if (local && cfg.trustLocal) return { ok: true, local };

  if (!cfg.token) return { ok: false, local, reason: "no-token-configured" };

  const presented = extractToken(req);
  if (!presented) return { ok: false, local, reason: "missing-token" };
  if (!safeEqual(presented, cfg.token)) return { ok: false, local, reason: "bad-token" };
  return { ok: true, local };
}

/** Human-readable 401 body for a failed remote auth. */
export function authFailureMessage(reason: AuthResult["reason"]): string {
  switch (reason) {
    case "no-token-configured":
      return "remote access is disabled — set dispatch.token (or AGI_DISPATCH_TOKEN) on the server.";
    case "missing-token":
      return "missing access token.";
    case "bad-token":
      return "invalid access token.";
    default:
      return "unauthorized.";
  }
}
