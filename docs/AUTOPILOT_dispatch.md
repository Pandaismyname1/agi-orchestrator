# Dispatch — remote mobile access to the AGI dashboard

Built under autopilot on 2026-06-30. Goal: reach the locally-running AGI dashboard
from a phone over the internet (an exposed port), with basic authentication and rate
limiting so only the owner can drive it, plus a genuinely good mobile UI for full
remote control (view state, send commands, start sessions, approve decisions).

## Contract (definition of done)

### Backend — auth
- [ ] `DispatchOptions` config (`src/types.ts`): `{ token?, trustLocal?(true), rateLimit? }`;
      token also from env `AGI_DISPATCH_TOKEN` (env wins). Threaded through `config.ts`,
      documented in `config.example.json`.
- [ ] `src/server/auth.ts`: `isLocalRequest(req)`, `extractToken(req)` (Authorization
      bearer / `X-AGI-Token` / `?token=` / cookie), `checkAuth(req, opts)` →
      `{ ok, local, reason? }`. Constant-time token compare.
- [ ] **Fail-safe default:** if no token is configured, remote access is REFUSED
      (local still works). Exposing the port without a token must NOT leak anything.
- [ ] **trustLocal:** loopback (127.0.0.1/::1) bypasses auth by default (zero local
      friction; the Stop-hook posts locally). `trustLocal:false` forces the token even
      locally (needed when a local tunnel like cloudflared makes traffic appear local).
- [ ] Gate every sensitive HTTP route (`/api/*`, `/attach`, `/detach`) and the
      WebSocket upgrade. Static shell (index.html/JS/CSS) stays open (non-sensitive).
      `/hook` stays local-only via trustLocal.
- [ ] `GET /api/whoami` → `{ ok, local, dispatchEnabled }` so the client can validate a
      token and decide whether to show the login gate.

### Backend — rate limiting
- [ ] `src/server/rateLimit.ts`: per-IP sliding-window limiters. General (default
      300 req / 60s) and a stricter auth-failure limiter (default 12 fails / 300s →
      longer cooldown, brute-force guard). Local bypasses. 429 + `Retry-After`.

### Frontend — auth/login + wiring
- [ ] `web/src/lib/auth.svelte.ts`: token store (localStorage), `whoami()`, state
      (`needsAuth`, `checking`, `local`).
- [ ] `web/src/components/Login.svelte`: full-screen mobile-first "Dispatch" gate —
      enter access token → validate → store → connect. Clear error on bad token.
- [ ] `api.ts` attaches the token (Authorization header) to every fetch; a 401 drops to
      the login gate. `ws.svelte.ts` appends `?token=` to the WS URL.
- [ ] `App.svelte` gates the app behind auth state. Sign-out control (Settings) clears
      the token.

### Frontend — mobile UI (full remote control on a phone)
- [ ] Header collapses cleanly on a phone (no overflow); all primary actions reachable.
- [ ] Core flows verified at 390px: fleet → open session → read live/transcript →
      send a message → approve a decision (attention panel) → start/stop → new session.
- [ ] Touch targets ≥44px on the primary controls; no horizontal scroll.

### Docs, config, tests
- [ ] `config.example.json` dispatch block + this doc's "How to expose safely" section.
- [ ] `scripts/dispatch-test.ts` (deterministic, no live server): local bypass; remote
      w/o token rejected; remote w/ valid token accepted; invalid rejected; disabled
      (no token) → remote refused; rate-limit trips + resets. Wired into `npm test`.
- [ ] README/ROADMAP note; memory pointer.

### Verification ladder — ALL DONE
- [x] Completion: backend `tsc` clean; `svelte-check` 0/0; `vite build` green; `npm test` green
      (context, learn, discovery, desktop, **dispatch** — 33 auth/limit assertions).
- [x] Quality: 2-round multi-agent adversarial review. Round 1 → 3 real issues
      (sibling-prefix path traversal, self-lockout ordering, WS reconnect storm) all fixed.
      Round 2 → confirmed those clean + found an unauthenticated `EISDIR` crash-DoS (directory
      read) → fixed with an `isFile()` guard + a process-level unhandled-rejection net. Every
      fix re-verified live (blocked IP recovers with the right token; sibling traversal 404s and
      leaks nothing; `GET /assets` 404s and the server survives; wrong tokens still converge to
      429).
- [x] Design: Playwright at 390px — login gate renders, wrong token rejected with an error,
      correct token loads the full app over the WS, token persists across reload; fleet, session
      detail + decision approve/deny panel, and the new-session wizard all usable on a phone.
      Local desktop is unaffected (loopback bypass).

### Status: COMPLETE. Dispatch is enabled in the local `config.json` with a generated token
(`trustLocal:true`), so it's usable immediately — see the token in that file (rotate anytime).

## How to expose safely (for the README + user)

The dashboard binds to a port; you forward that port to the internet. **The token
travels in the request — over plain HTTP it can be sniffed.** Preferred options:

1. **Tailscale (recommended):** install on the PC and phone; reach the dashboard at the
   PC's tailnet IP. No public exposure, encrypted, no port-forward. Keep a token too.
2. **Cloudflare Tunnel / ngrok:** gives an HTTPS URL. Because the tunnel connects to
   localhost, set `dispatch.trustLocal:false` so the token is still required.
3. **Raw port-forward:** works, but it's plain HTTP — only acceptable on a trusted
   network or behind a TLS proxy. Always set a strong token.

Set the token via `config.json` `dispatch.token` or the `AGI_DISPATCH_TOKEN` env var.

## Decision log

- **D1 — Trust loopback, gate remote (configurable).** Loopback bypasses auth so local
  use and the Stop-hook have zero friction; remote requires the token. `trustLocal:false`
  covers the local-tunnel case where traffic appears to originate from localhost.
  Rejected: always-require-token (annoying locally) and IP allowlists (brittle on
  mobile/CGNAT).
- **D2 — Fail-safe when unconfigured.** No token ⇒ remote refused, not open. Exposing
  the port before setting a token cannot leak state. The safe default beats convenience.
- **D3 — Static shell stays public.** The HTML/JS bundle is not sensitive; protecting
  data + commands (API + WS) is what matters. Keeps the login screen itself loadable.
- **D4 — Token transport = header + query.** Browsers can't set headers on the WS
  upgrade or initial nav, so `?token=` is accepted alongside `Authorization`. Stored in
  localStorage. Constant-time compare to avoid timing leaks.
- **D5 — Cleartext caveat documented, not solved in-app.** TLS termination belongs to a
  tunnel/proxy; building cert handling is out of scope for "basic." Boot prints a
  warning when dispatch is enabled so the risk is visible.
