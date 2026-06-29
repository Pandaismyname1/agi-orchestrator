# AGI — local autopilot orchestrator for Claude Code

Drives **interactive Claude Code sessions** unattended, using a **local LLM (Qwen via
LM Studio / Ollama)** as a stand-in for you: it reads what Claude said when a turn ends,
decides the next instruction (or STOP), and injects it — so Claude never sits idle waiting
for you to type "ok, continue". Built to run several projects in parallel without you
context-switching.

**Local-only. Solo. No data leaves the machine. Subscription-safe by design.**

---

## Why it's subscription-safe (the core constraint)

The whole point is to **not** incur pay-per-token API costs. So:

- It does **NOT** use the `@anthropic-ai/claude-agent-sdk` (that path is built around an API
  key = pay-per-token billing).
- It drives the **real `claude.exe` CLI** — the genuine interactive process logged into your
  subscription — inside a pseudo-terminal (PTY) we own. Anything it does draws from your
  subscription, exactly like using Claude by hand.
- A **hard preflight guard** (`src/util/env.ts`) aborts startup if `ANTHROPIC_API_KEY`,
  Bedrock/Vertex vars, or a non-official `ANTHROPIC_BASE_URL` are present — so an automated
  loop can never silently bill you.
- Spawned sessions get a **scrubbed environment** (parent Claude-session vars stripped) so
  they authenticate via your normal cached subscription credentials.

> The real "budget" here isn't dollars (the subscription is flat) — it's your **rate-limit /
> weekly cap**. Guards cap turns, wall-clock, and ping-pong loops.

**Requirement:** the standalone `claude` CLI must be logged into your subscription. Run
`claude` once in a normal terminal and `/login` if needed.

---

## How it works

```
 ┌─ ClaudeSession (owns a PTY running real claude.exe) ─────────────┐
 │   inject goal ─► claude works ─► turn ends ─► read reply         │
 └──────────────────────────────────────────┬──────────────────────┘
                                             │ reply text (from transcript JSONL)
                                             ▼
                        brain (local Qwen): "as the user, next step or STOP?"
                                             │
                          guards: turns / wall-clock / ping-pong
                                             │
                                next prompt ─┘  ► inject ► repeat
```

Key mechanisms, all validated end-to-end against the real CLI:

- **PTY ownership** — `node-pty` (ConPTY, `useConptyDll: true` to dodge the
  `conpty_console_list_agent` crash). Spawn, read stream, write keystrokes.
- **Clean screen reads** — Claude's TUI encodes the screen with cursor-movement escapes, not
  plain text. We run a headless VT emulator (`@xterm/headless`, `src/terminal/screen.ts`) to
  reconstruct readable screen text for **state detection** (working / ready / gate).
- **Turn-end detection** — `src/terminal/state.ts` classifies the screen; a turn ends when
  Claude returns to a settled "ready" input box.
- **Gate handling** — first-run trust dialog, MCP-server approval, permission prompts are
  detected and auto-confirmed at their default ("proceed") option. `--permission-mode
  acceptEdits` (configurable) minimizes these.
- **Reply reading** — the assistant's message **text** comes from the transcript JSONL
  (clean, stable), located deterministically via a forced `claude --session-id <uuid>`.
- **The brain** — `src/brain/decide.ts` prompts the local model to act as the operator,
  anchored to the original goal, and emit `{action: continue|stop, prompt, reason}`.

---

## Run it

1. Start **LM Studio** (`http://localhost:1234/v1`) or **Ollama** (`http://localhost:11434/v1`)
   with a capable instruct model (e.g. a Qwen 30B+).
2. `npm install`
3. Copy `config.example.json` → `config.json`, set `provider.model` to a model the server
   reports, and define your session(s): `cwd`, `goal`, `doneCriteria`.
4. `npm run dashboard` → open `http://localhost:4317` → **Start all** (or start sessions
   individually). Watch each session's live screen, status, turn count, and the brain's last
   decision; Stop any session from its card.

Prefer a headless console runner? `npm run daemon` runs all sessions and logs the event stream.

### Scripts
- `npm run dashboard` — web cockpit (HTTP + WebSocket), start/stop + live screens.
- `npm run daemon` — headless: run the orchestrator over all sessions, log to console.
- `npm run pty-smoke` — prove PTY spawn/read/inject against real claude.
- `npx tsx scripts/session-smoke.ts` — exercise the full session driver (one turn).
- `npx tsx scripts/ws-test.ts` — drive the dashboard over its WebSocket (server must be up).
- `npm run typecheck`

---

## Project layout

```
src/
  db/store.ts            SQLite persistence (node:sqlite) — sessions/runs/turns/decisions/events
  db/recorder.ts         maps the orchestrator event stream into the store
  db/schema.ts           schema (incl. attention_requests + preferences for later tiers)
  server/index.ts        dashboard: HTTP + WebSocket server (preflight → config → serve)
  server/supervisor.ts   manages all sessions; live state + start/stop for the dashboard
  server/public/index.html  single-page cockpit (live screens, status, start/stop)
  daemon/index.ts        headless entry: preflight → config → LLM health → run sessions
  orchestrator.ts        the autopilot loop (session + brain + guards)
  session/claudeSession.ts  owns a PTY running claude; drives turns; handles gates
  terminal/screen.ts     headless VT emulator → clean screen text
  terminal/state.ts      screen-state classifier (working/ready/gate) + auth-error detect
  transcript/reader.ts   read last assistant message from transcript JSONL
  brain/provider.ts      OpenAI-compatible client (LM Studio / Ollama)
  brain/decide.ts        "act as the user" decision logic
  policy/guards.ts       turn / wall-clock / ping-pong guards
  util/env.ts            billing-safety preflight + env scrub
  config.ts, types.ts
scripts/                 smoke / integration tests
```

## Status

Working and tested end-to-end: subscription auth, PTY drive loop, gate handling, transcript
reads, brain decisions, guards, clean teardown, and the web dashboard (live screen-streaming
+ start/stop over WebSocket).

Validated features:
- **Multi-session in parallel** — two sessions driven concurrently to completion from the dashboard.
- **Session CRUD from the UI** — add / edit / remove sessions, persisted to `config.json`.
- **Richer brain context** — the brain sees recent history (injected prompts + replies), not just the last message.
- **Hook-attach mode** — drive a `claude` you started by hand via a Stop hook → daemon → brain → injected next prompt.
- **SQLite persistence (Tier 0)** — every run / turn / decision / event is recorded to a local `agi.db`
  (Node's built-in `node:sqlite`, no native build), via a `Recorder` on the orchestrator event stream.
  Survives restarts; foundation for history, resume, and analytics. `dbPath` configurable (default `./agi.db`).
- **Human-decision escalation / "attention" (Tier 1)** — the brain classifies each turn-end as
  routine (auto-continue), done (stop), or a genuine human decision (**escalate**). On escalate it
  proposes 2–4 concrete options; the session pauses in a loud **needs-input** state in the dashboard;
  you pick an option (or type your own / stop) and it resumes. Persisted to `attention_requests`.
  The brain is pluggable (`decide` override) — use a fast model: **qwen3.5:9b ≈ 2–3s/decision, 88%**
  on the decision eval (the 35B was 27–52s; see `scripts/brain-eval.ts`).

### Hook-attach mode (optional)

To drive a session you start by hand instead of a daemon-owned one:
1. Run the dashboard (it exposes `POST /attach`, `/detach`, `/hook`).
2. Register the session's goal: `POST /attach {session_id, goal, doneCriteria}`.
3. Add a Stop hook in your Claude `settings.json` pointing at `node <abs>/hook/stop-hook.mjs`
   (see `src/attach/INTEGRATION.md` for the exact snippet + `AGI_DAEMON_URL`).
4. Start your session with that id: `claude --session-id <that-uuid>`. From each turn-end on,
   the daemon decides and the hook injects the next step. The hook fails open — if the daemon
   is down it never blocks your session.

### Not built yet
- Chrome Picture-in-Picture always-on status window (Tier 1 — rides on the needs-input status model; next up).
- Per-gate safety policy (currently auto-confirms default; rely on `permissionMode` + brain + escalation).
- Dashboard UI panel for attach/detach (routes exist; wire a form like the session CRUD).
- Brain history is last-N messages, not summarized — fine for now, may need trimming on very long runs.
