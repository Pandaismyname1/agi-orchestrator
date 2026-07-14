# Documentation

Everything beyond the top-level [README](../README.md) and [ROADMAP](../ROADMAP.md).

## Start here

| Doc | What it covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it all fits together — system context, the autopilot loop, the turn state machine, fleet orchestration, safety enforcement, deployment topologies (with diagrams). |
| [CONFIGURATION.md](CONFIGURATION.md) | Every `config.json` block, safety-critical settings, and environment variables. Backed by [`schemas/config.schema.json`](../schemas/config.schema.json). |
| [DATA_MODEL.md](DATA_MODEL.md) | The SQLite store (`agi.db`): tables, relationships (ER diagram), and the read APIs behind history/metrics. |
| [DOCKER.md](DOCKER.md) | Running the container stack, the host-networking constraint, and the bundled-Ollama variant. |

## Operations & remote use

| Doc | What it covers |
| --- | --- |
| [AUTOPILOT_dispatch.md](AUTOPILOT_dispatch.md) | Reaching the dashboard from your phone: token auth, tunnels, rate limiting. |

## Design & decision records

| Doc | What it covers |
| --- | --- |
| [AUTOPILOT_brain_resilience.md](AUTOPILOT_brain_resilience.md) | The transcript-first recovery ladder + supervisor self-heal design. |
| [AUTOPILOT_brain_resilience_DECISIONS.md](AUTOPILOT_brain_resilience_DECISIONS.md) | The decision log behind the resilience work. |
| [AUTOPILOT_flow_fixes.md](AUTOPILOT_flow_fixes.md) | Session-flow fixes (idle-screen recognition, prompt-submission verification, exit diagnostics). |

## Project meta

| Doc | Where |
| --- | --- |
| Contributing guide | [../CONTRIBUTING.md](../CONTRIBUTING.md) |
| Security policy & threat model | [../SECURITY.md](../SECURITY.md) |
| Code of conduct | [../CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) |
| Changelog | [../CHANGELOG.md](../CHANGELOG.md) |

---

## Command reference

Run from the repo root. Full details in the [README](../README.md#scripts) and
[CONTRIBUTING](../CONTRIBUTING.md#development-workflow).

### Everyday

| Command | Does |
| --- | --- |
| `npm run setup` | Install server + dashboard dependencies (first run). |
| `npm start` / `npm run launch` | Build the UI, serve the dashboard, open the browser (`:4317`). |
| `npm run dashboard` | Serve the dashboard without rebuilding / opening a browser. |
| `npm run dev` | Dashboard with `tsx watch` (auto-restart on server changes). |
| `npm run daemon` | Headless: run all sessions, log the event stream to console. |
| `npm run build` | Build the dashboard UI (`web/dist`). |

### Checks (offline — what CI runs)

| Command | Does |
| --- | --- |
| `npm run typecheck` | Type-check the server. |
| `npm run web:check` | Type-check the UI. |
| `npm test` | Deterministic unit tests. **No claude CLI or LLM needed.** |

### Live validation (need a claude login + a local model)

| Command | Does |
| --- | --- |
| `npm run pty-smoke` | Prove PTY spawn/read/inject against the real `claude`. |
| `npm run smoke` | End-to-end smokes (spin-loop, agent turn, usage). |
| `npm run brain-validate` | Validate the brain's decisions against the live model. |

### Web workspace

| Command | Does |
| --- | --- |
| `npm run web:install` | Install UI dependencies. |
| `npm run web:dev` | Vite dev server for the UI alone. |
| `npm run web:build` | Build the UI. |
