---
layout: default
title: Getting Started
nav_order: 2
---

# Getting Started

## Prerequisites

- **Node.js ≥ 22.5** — the daemon and dashboard server run on it.
- **The `claude` CLI, logged into your subscription.** Run `claude` once in a normal
  terminal and `/login` if needed — the orchestrator drives this real process, it doesn't
  replace it.
- **A local LLM** to act as the "brain": [LM Studio](https://lmstudio.ai/) serving on
  `http://localhost:1234/v1`, or [Ollama](https://ollama.com/) on
  `http://localhost:11434/v1`, with a capable instruct model (e.g. a Qwen 30B+).

## Install and run

1. Start LM Studio or Ollama with your chosen model loaded.
2. Install dependencies (first run only):

   ```sh
   npm run setup
   ```

   This installs both the server and the dashboard UI dependencies.
3. Create your config:

   ```sh
   cp config.example.json config.json
   ```

   Set `provider.model` to a model name your local server reports, and define your
   session(s): `cwd`, `goal`, `doneCriteria`. See the [Configuration reference](CONFIGURATION)
   for every field.
4. Start it:

   ```sh
   npm start
   ```

   This builds the latest dashboard UI, starts the server, and opens
   `http://localhost:4317` in your browser. Click **Start all**, or start sessions
   individually.

> **Windows desktop shortcut:** double-click `launch.cmd` (or run it once to drop an
> *"AGI Dashboard"* shortcut on your desktop) to do all of the above with one click — it
> installs dependencies on first run too. Close the window (or `Ctrl+C`) to stop.

Prefer a headless console runner instead of the dashboard? `npm run daemon` runs all
sessions and logs the event stream straight to the console.

## Everyday scripts

| Command | Does |
| --- | --- |
| `npm start` / `npm run launch` | Build the UI, serve the dashboard, open the browser. |
| `npm run dashboard` | Serve the dashboard without rebuilding the UI / opening a browser. |
| `npm run dev` | Dashboard with `tsx watch` (auto-restart on server-code changes). |
| `npm run daemon` | Headless: run every session, log the event stream to console. |
| `npm run build` | Build the dashboard UI only (`web/dist`). |

## Checks (offline — what CI runs)

| Command | Does |
| --- | --- |
| `npm run typecheck` | Type-check the server. |
| `npm run web:check` | Type-check the UI. |
| `npm test` | Deterministic unit tests. No `claude` CLI or LLM needed. |

## Live validation (needs a `claude` login + a local model)

| Command | Does |
| --- | --- |
| `npm run pty-smoke` | Prove PTY spawn/read/inject against the real `claude`. |
| `npm run smoke` | End-to-end smokes (spin-loop, agent turn, usage). |
| `npm run brain-validate` | Validate the brain's decisions against the live model. |

## Next steps

- Reach the dashboard from your phone: [Remote Dashboard Access](AUTOPILOT_dispatch).
- Run it in a container instead: [Docker](DOCKER).
- Understand the turn-detection and safety-guard design: [Architecture](ARCHITECTURE).
