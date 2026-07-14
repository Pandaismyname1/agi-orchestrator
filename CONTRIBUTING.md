# Contributing to AGI Orchestrator

Thanks for your interest in improving the project! This document explains how to get a dev
environment running, the conventions we follow, and how to propose changes.

> **The one non-negotiable rule: keep it local-only and subscription-safe.** No change may
> route Claude usage through the pay-per-token API, add the `@anthropic-ai/claude-agent-sdk`,
> or send the local decision brain to a non-loopback endpoint. The billing preflight
> (`src/util/env.ts`) and the loopback provider check (`src/config.ts`) exist to enforce this —
> don't weaken them. See [SECURITY.md](SECURITY.md) for the threat model.

---

## Prerequisites

- **Node.js ≥ 22.5.0** (the store uses the built-in `node:sqlite`, no native build).
- The standalone **`claude` CLI**, logged into your subscription (`claude` → `/login`).
- A local OpenAI-compatible LLM server for the brain — **LM Studio** (`:1234`) or
  **Ollama** (`:11434`) — running a fast instruct model (e.g. `qwen3.5:9b`).
- A C toolchain for `node-pty` (usually already present; on Linux install `build-essential`
  and `python3`).

## Getting started

```bash
git clone https://github.com/Pandaismyname1/agi-orchestrator.git
cd agi-orchestrator
npm run setup                     # installs server + web deps
cp config.example.json config.json
# edit config.json: set provider.model to a model your local server reports
npm start                         # builds the UI, serves the dashboard on :4317
```

See the [README](README.md) for the full run guide and [docs/](docs/README.md) for architecture.

## Project layout

A one-line map lives in the [README](README.md#project-layout); the full architecture with
diagrams is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

- `src/` — the TypeScript server: orchestrator loop, PTY session driver, brain, policies, DB.
- `web/` — the Svelte dashboard (Vite build → `web/dist`, served by the server).
- `scripts/` — deterministic unit tests and live smoke tests (`*-test.ts`, `*-smoke.ts`).
- `docs/` — architecture, configuration reference, and design/decision records.

## Development workflow

| Command | What it does |
| --- | --- |
| `npm run dev` | Dashboard with `tsx watch` (auto-restart on server changes). |
| `npm run web:dev` | Vite dev server for the UI alone. |
| `npm test` | Deterministic unit tests — **no LLM or claude CLI required**. |
| `npm run typecheck` | Type-check the server (`tsc --noEmit`). |
| `npm run web:check` | Type-check the UI (`svelte-check`). |
| `npm run pty-smoke` | Live: prove PTY spawn/read/inject against real `claude`. |
| `npm run smoke` | Live end-to-end smokes (need claude + a local model). |

**Before opening a PR, please run:**

```bash
npm run typecheck && npm run web:check && npm test && npm run build
```

These are exactly what CI runs (see `.github/workflows/ci.yml`). The `test` target is
deterministic and offline; the `smoke` / `brain-validate` / `pty-smoke` targets need a live
claude login and a local model, so they are **not** part of CI — run them locally when you
touch the PTY, brain, or session-driver code.

## Coding conventions

- **TypeScript, ES modules, `.js` import specifiers** (NodeNext resolution — import
  `./foo.js`, not `./foo.ts`).
- **Match the surrounding code.** The codebase favors small, single-purpose modules with a
  short doc-comment at the top explaining the "why". Keep that density.
- **New behavior gets a deterministic test** in `scripts/` and is wired into the `test`
  script in `package.json`. Prefer clock-injectable, timer-free logic (see
  `src/policy/schedule.ts` for the pattern) so it's testable without waiting.
- **No new runtime dependencies without discussion.** The dependency list is deliberately
  tiny (`@xterm/headless`, `node-pty`, `ws`). Open an issue first.
- **Respect the safety guards.** If your change touches env handling, provider config, or
  spawning, add or update a test that proves the guard still fires.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(brain): add rolling-summary context mode
fix(session): recognize the new idle-screen banner
docs: expand the dispatch setup guide
test: cover the ping-pong guard edge case
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`.

## Pull requests

1. Fork and branch from `main` (`feat/…`, `fix/…`).
2. Keep PRs focused — one logical change per PR.
3. Fill in the PR template (what/why/how-tested).
4. Ensure the pre-PR checks above pass.
5. Update docs (`README.md`, `docs/`, `config.example.json` notes) when behavior or config
   changes.

Maintainers review for correctness, the safety invariant, test coverage, and doc updates.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/Pandaismyname1/agi-orchestrator/issues/new/choose).
For anything security-sensitive (especially around the dispatch remote-access surface or the
billing guard), follow [SECURITY.md](SECURITY.md) instead of filing a public issue.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers the project.
