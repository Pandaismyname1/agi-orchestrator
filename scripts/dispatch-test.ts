/**
 * Deterministic test for the dispatch security core — token auth + rate limiting.
 * No live server: exercises src/server/auth.ts and src/server/rateLimit.ts directly
 * with fake requests and an injected clock. Covers the fail-safe (no token ⇒ remote
 * refused), loopback trust, every token transport, constant-time compare, and the
 * sliding-window + brute-force limiters.
 */
import type { IncomingMessage } from "node:http";
import {
  resolveAuthConfig,
  isLocalRequest,
  extractToken,
  safeEqual,
  checkAuth,
  type AuthConfig,
} from "../src/server/auth.js";
import { RateLimiter, resolveRateLimitConfig } from "../src/server/rateLimit.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

/** Minimal IncomingMessage stand-in for the bits auth.ts reads. */
function req(opts: { ip?: string; headers?: Record<string, string>; url?: string }): IncomingMessage {
  return {
    headers: opts.headers ?? {},
    url: opts.url ?? "/",
    socket: { remoteAddress: opts.ip ?? "203.0.113.7" },
  } as unknown as IncomingMessage;
}

// ---- resolveAuthConfig ----
check("env token wins over config", resolveAuthConfig({ token: "cfg" }, { AGI_DISPATCH_TOKEN: "env" } as NodeJS.ProcessEnv).token === "env");
check("config token used when no env", resolveAuthConfig({ token: "cfg" }, {} as NodeJS.ProcessEnv).token === "cfg");
check("whitespace-only token counts as unset", resolveAuthConfig({ token: "   " }, {} as NodeJS.ProcessEnv).token === "");
check("trustLocal defaults true", resolveAuthConfig({ token: "x" }, {} as NodeJS.ProcessEnv).trustLocal === true);
check("trustLocal:false respected", resolveAuthConfig({ token: "x", trustLocal: false }, {} as NodeJS.ProcessEnv).trustLocal === false);

// ---- isLocalRequest ----
check("127.0.0.1 is local", isLocalRequest(req({ ip: "127.0.0.1" })));
check("::1 is local", isLocalRequest(req({ ip: "::1" })));
check("IPv4-mapped loopback is local", isLocalRequest(req({ ip: "::ffff:127.0.0.1" })));
check("public IP is NOT local", !isLocalRequest(req({ ip: "203.0.113.7" })));

// ---- extractToken (every transport) ----
check("bearer header", extractToken(req({ headers: { authorization: "Bearer abc123" } })) === "abc123");
check("X-AGI-Token header", extractToken(req({ headers: { "x-agi-token": "abc123" } })) === "abc123");
check("query param", extractToken(req({ url: "/ws?token=abc123" })) === "abc123");
check("cookie", extractToken(req({ headers: { cookie: "foo=1; agi_token=abc123; bar=2" } })) === "abc123");
check("none ⇒ empty", extractToken(req({})) === "");

// ---- safeEqual ----
check("safeEqual equal ⇒ true", safeEqual("supersecret", "supersecret") === true);
check("safeEqual same-length differ ⇒ false", safeEqual("supersecret", "supersecr_t") === false);
check("safeEqual different length ⇒ false (no throw)", safeEqual("short", "muchlongertoken") === false);

// ---- checkAuth: the core gate ----
const enabled: AuthConfig = { token: "T0KEN", trustLocal: true };
const enabledStrict: AuthConfig = { token: "T0KEN", trustLocal: false };
const disabled: AuthConfig = { token: "", trustLocal: true };

check("local + trustLocal ⇒ allowed, no token", checkAuth(req({ ip: "127.0.0.1" }), enabled).ok === true);
check(
  "local + trustLocal:false + no token ⇒ rejected",
  checkAuth(req({ ip: "127.0.0.1" }), enabledStrict).ok === false,
);
check(
  "local + trustLocal:false + good token ⇒ allowed",
  checkAuth(req({ ip: "127.0.0.1", headers: { authorization: "Bearer T0KEN" } }), enabledStrict).ok === true,
);

// FAIL-SAFE: no token configured ⇒ remote refused.
const remoteNoToken = checkAuth(req({ ip: "203.0.113.7" }), disabled);
check("remote + dispatch disabled ⇒ refused", remoteNoToken.ok === false && remoteNoToken.reason === "no-token-configured");

check("remote + correct token (header) ⇒ ok", checkAuth(req({ ip: "203.0.113.7", headers: { authorization: "Bearer T0KEN" } }), enabled).ok === true);
check("remote + correct token (query) ⇒ ok", checkAuth(req({ ip: "203.0.113.7", url: "/ws?token=T0KEN" }), enabled).ok === true);
const wrong = checkAuth(req({ ip: "203.0.113.7", headers: { authorization: "Bearer nope" } }), enabled);
check("remote + wrong token ⇒ bad-token", wrong.ok === false && wrong.reason === "bad-token");
const missing = checkAuth(req({ ip: "203.0.113.7" }), enabled);
check("remote + missing token ⇒ missing-token", missing.ok === false && missing.reason === "missing-token");

// ---- RateLimiter (injected clock) ----
let t = 1_000_000;
const rl = new RateLimiter(
  resolveRateLimitConfig({ windowMs: 1000, maxRequestsPerWindow: 3, authWindowMs: 5000, maxAuthFailures: 3 }),
  () => t,
);
const ip = "203.0.113.7";
check("hit 1 ok", rl.hit(ip).ok);
check("hit 2 ok", rl.hit(ip).ok);
check("hit 3 ok", rl.hit(ip).ok);
const over = rl.hit(ip);
check("hit 4 blocked with retryAfter", over.ok === false && (over.retryAfterSec ?? 0) >= 1);
t += 1001; // slide past the window
check("after window slides, hit ok again", rl.hit(ip).ok);

// brute-force guard
const rl2 = new RateLimiter(
  resolveRateLimitConfig({ authWindowMs: 5000, maxAuthFailures: 3 }),
  () => t,
);
check("not auth-blocked initially", rl2.authBlocked(ip).ok);
rl2.recordAuthFailure(ip);
rl2.recordAuthFailure(ip);
rl2.recordAuthFailure(ip);
check("auth-blocked after 3 failures", rl2.authBlocked(ip).ok === false);
rl2.clearAuthFailures(ip);
check("clearAuthFailures resets the guard", rl2.authBlocked(ip).ok === true);

console.log(`\n[dispatch] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
