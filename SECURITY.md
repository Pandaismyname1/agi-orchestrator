# Security Policy

AGI Orchestrator drives real, subscription-authenticated `claude` processes on your machine
and can optionally expose a remote-control dashboard. Its security posture is central to the
project, so please read this before deploying it anywhere but a trusted local machine.

## Supported versions

The project is pre-1.0 and moves fast. Security fixes land on `main` and the latest release
only.

| Version | Supported |
| --- | --- |
| `main` / latest | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, use GitHub's private
[**Report a vulnerability**](https://github.com/Pandaismyname1/agi-orchestrator/security/advisories/new)
flow, or email the maintainer at **pandaismyname1@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof-of-concept if you have one),
- affected version / commit.

You can expect an initial acknowledgment within a few days. We'll work with you on a fix and a
coordinated disclosure, and credit you unless you prefer to stay anonymous.

## The security model

Understanding the design helps you report meaningful issues and deploy safely.

### 1. Billing / subscription safety (the core invariant)

The whole project is built so an automated loop can **never silently bill you** through the
pay-per-token API. Two guards enforce it:

- **Billing preflight** (`src/util/env.ts`) — startup **hard-aborts** if `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, Bedrock/Vertex vars, or a non-official `ANTHROPIC_BASE_URL` are
  present. Spawned sessions also get a **scrubbed environment** so they can't inherit an API
  key.
- **Loopback-only brain** (`src/config.ts`) — the local decision model's `baseUrl` must resolve
  to `localhost` / `127.0.0.1` / `::1`. A remote provider URL is refused. The same check gates
  the optional OpenCode engine's paid providers behind an explicit opt-in.

**A bug that defeats either guard is a security issue.** Report it privately.

### 2. Remote access ("dispatch")

The dashboard can be exposed to reach it from your phone. The relevant properties:

- With **no `dispatch.token` set, all non-loopback requests are refused.** Local use is
  unaffected.
- A token (or the `AGI_DISPATCH_TOKEN` env var) is required for remote clients and is checked
  on every request (`Authorization: Bearer`, `X-AGI-Token`, or `?token=`).
- **Per-IP rate limiting** throttles request floods and, more strictly, auth failures
  (brute-force guard) — see `src/server/rateLimit.ts`.
- `dispatch.trustLocal` (default `true`) trusts loopback; set it **`false`** when you front the
  dashboard with a local tunnel (cloudflared/ngrok) so the token is still required.

**Deployment guidance:**

- The token travels in the request. **Prefer a TLS tunnel** —
  [Tailscale](https://tailscale.com) or a Cloudflare Tunnel — over bare HTTP. Do not port-forward
  plain HTTP to the public internet.
- Use a long, random token. Rotate it if you suspect exposure.
- The dashboard can start/stop sessions and inject prompts into agents that may have file-system
  and shell access. **Treat dashboard access as equivalent to shell access to every session's
  working directory.**

### 3. Agent permissions & gate safety

Sessions run `claude` with a configurable `permissionMode`. Looser modes reduce interactive
gates but grant the agent more autonomy:

- `bypassPermissions` is fully unattended and **riskiest** — the agent won't stop for anything.
- With `permissionMode: "default"` and `gatePolicy: "guard"` (recommended for unattended runs),
  dangerous gates (`rm -rf`, `git push --force`, `sudo`, pipe-to-shell, secrets, network
  exfiltration) are classified (`src/terminal/gates.ts`) and **escalated** to you, and
  **default-denied** when no one is watching.

Choose the permission mode deliberately per session, especially for scheduled/unattended work.

### 4. Local data

- The SQLite store (`agi.db`) and logs (`logs/`) contain your goals, prompts, and the agent's
  replies. They are local and git-ignored by default. Don't commit them.
- `config.json` may contain your `dispatch.token` and is git-ignored. Never commit it.

## Scope

In scope: the billing/loopback guards, the dispatch auth & rate-limit surface, gate
classification, env scrubbing, and any path that could execute unintended commands or leak
credentials/tokens.

Out of scope: vulnerabilities in third-party software you point this at (the `claude` CLI, your
local LLM server, your OS), and misconfigurations that ignore the guidance above (e.g.
port-forwarding plain HTTP with a weak token).
