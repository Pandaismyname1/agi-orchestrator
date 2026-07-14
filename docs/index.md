---
layout: default
title: Home
nav_order: 1
permalink: /
---

# AGI Orchestrator

**Local autopilot orchestrator for Claude Code.** Drive interactive Claude Code sessions
**unattended** — a local LLM stands in for you, reads each finished turn, and decides the
next step (or STOP). Run a whole fleet in parallel.

> **Local-only. Solo. No data leaves the machine. Subscription-safe by design.**
{: .fs-6 .fw-300 }

[Get started](getting-started){: .btn .btn-primary .fs-5 .mb-4 .mb-md-0 .mr-2 }
[View on GitHub](https://github.com/Pandaismyname1/agi-orchestrator){: .btn .fs-5 .mb-4 .mb-md-0 }

---

## What it does

AGI Orchestrator drives the **real, interactive `claude` CLI** unattended, using a **local
LLM** (the "brain") as a stand-in for you: when a turn ends it reads what Claude said,
decides the next instruction (or `STOP`), and injects it — so Claude never sits idle
waiting for you to type "ok, continue." It's built to run several projects in parallel
without you context-switching.

It deliberately does **not** use the `@anthropic-ai/claude-agent-sdk` (API-key,
pay-per-token) path. It drives the genuine `claude.exe` process inside a PTY it owns, so
everything it does draws from your normal Claude subscription — exactly like using Claude
by hand. A hard preflight guard aborts startup if API-key or non-official endpoint
environment variables are present.

## Where to go next

| Page | What it covers |
| --- | --- |
| [Getting Started](getting-started) | Prerequisites, install, first run, and the desktop shortcut. |
| [Architecture](ARCHITECTURE) | System context, the autopilot loop, the turn state machine, fleet orchestration, safety enforcement, deployment topologies — with diagrams. |
| [Configuration](CONFIGURATION) | Every `config.json` block, safety-critical settings, and environment variables. |
| [Data Model](DATA_MODEL) | The SQLite store (`agi.db`): tables, relationships, and the read APIs behind history/metrics. |
| [Docker](DOCKER) | Running the container stack, the host-networking constraint, and the bundled-Ollama variant. |
| [Remote Dashboard Access](AUTOPILOT_dispatch) | Reaching the dashboard from your phone: token auth, tunnels, rate limiting. |
| [Design & Decision Records](design-decisions) | Why the turn-state machine and brain-resilience logic look the way they do. |

Project-level docs — [Contributing](https://github.com/Pandaismyname1/agi-orchestrator/blob/main/CONTRIBUTING.md),
[Security Policy](https://github.com/Pandaismyname1/agi-orchestrator/blob/main/SECURITY.md),
[Changelog](https://github.com/Pandaismyname1/agi-orchestrator/blob/main/CHANGELOG.md), and
[Roadmap](https://github.com/Pandaismyname1/agi-orchestrator/blob/main/ROADMAP.md) — live at
the repo root and are linked in the sidebar.
