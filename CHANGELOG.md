# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-14

### Added
- Open-source release scaffolding: `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, this changelog.
- GitHub project files: CI workflow (typecheck, tests, build), issue/PR templates, Dependabot.
- Docker stack: `Dockerfile`, `.dockerignore`, `docker-compose.yml` (app image + host
  LLM/credentials), and [`docs/DOCKER.md`](docs/DOCKER.md).
- Machine-readable [`schemas/config.schema.json`](schemas/config.schema.json) (JSON Schema
  2020-12) for `config.json`, referenced from `config.example.json`.
- Documentation set under [`docs/`](docs/README.md): architecture with Mermaid diagrams,
  a full configuration reference, and a data-model reference.

### Changed
- `package.json` gains OSS metadata (license, repository, keywords, `engines`).

---

## Project history (pre-release)

The project was developed as a private working repository before this public release. The
feature set at release time (summarized from `README.md` and `ROADMAP.md`):

### Core
- PTY-owned driving of the real interactive `claude` CLI (subscription-safe; no Agent SDK, no
  API key), with a billing preflight and scrubbed spawn environment.
- Headless VT emulation for clean screen reads; turn-end / gate / choice-menu detection.
- Transcript-first reply reading via a forced `claude --session-id`.
- Local-LLM "brain" (Qwen via LM Studio / Ollama) that decides continue / stop / escalate.
- Guards: turn count, wall-clock, ping-pong, stuck/oscillation detection.

### Fleet & product
- Web dashboard (Svelte) with live screen streaming, start/stop, multi-session concurrency
  cap + queue, and session CRUD persisted to `config.json`.
- Human-decision escalation ("attention"), per-gate safety policy, PiP status window and
  desktop notifications.
- Manual/autopilot mode toggle, adopt-existing-session, session templates, operator personas.
- Observability: SQLite persistence, history, timeline replay, and metrics.

### Automation
- Usage budgeting + real `/usage` rate-limit guard; workflow dependency DAG; scheduled /
  recurring sessions; outbound Slack/Discord/JSON webhooks; reactive automation rules; quiet
  hours; goal-intake assistant; ⌘K command palette; workflow graph view.
- Remote access ("dispatch") with token auth + per-IP rate limiting.
- Alternate engines: `claude-headless` (`claude -p`, stream-json) and OpenCode (over
  `opencode serve`).
- Reliability: brain-call retries, auto-pause on unreachable model, transcript-first recovery
  ladder, and supervisor self-heal.

[Unreleased]: https://github.com/Pandaismyname1/agi-orchestrator/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Pandaismyname1/agi-orchestrator/releases/tag/v0.1.0
