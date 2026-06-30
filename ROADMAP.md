# AGI orchestrator — roadmap / feature backlog

Planning doc. Tiers are rough priority. The three the owner originally flagged as must-haves
are marked **★MUST**.

Guiding principle stays fixed: **local-only, subscription-safe** (no Agent SDK, no API key,
billing preflight). Every feature below must respect that.

**Status (built so far):** Tiers 0–2 are DONE — SQLite persistence; human-decision escalation;
PiP status window; per-gate safety; usage budget + rate-limit guard; observability
(history/replay/metrics); concurrency cap + queue; stuck detection. Tier 3: operator personas done.

> **The next priority is the Product & UX track below — it supersedes the remaining Tier 3
> extras.** A brilliant design (UX + UI) is the goal; the design dictates the backend work.

---

## Product & UX track — NEXT PRIORITY

The orchestrator is capable but its UX is utilitarian and it assumes you create sessions from
config. These four reframe it as a polished product. Design-first: nail the experience, and the
backend requirements fall out of it.

### P1. Onboarding + context-aware sessions + manual/autopilot toggle ★ — DONE

Today a session is born already on autopilot from a config goal. Real use wants to **seed a
session by hand first, then hand it to Qwen.**

- **Two modes per session, with a toggle:**
  - **Manual (passthrough):** the user types directly to the claude agent through the dashboard;
    **Qwen does NOT respond.** You chat with the agent, give initial instructions, paste context,
    course-correct — exactly like using claude by hand, but inside our cockpit.
  - **Autopilot (Qwen loop):** the current behavior — Qwen reads each turn-end and drives.
  - A prominent **per-session toggle** flips between them at ANY time (pause autopilot to take the
    wheel; resume when ready).
- **Onboarding flow:** create session → it opens in **manual** mode → you type the initial
  instructions / drop context → flip the toggle → the Qwen loop starts *from the current state*.
  Because it's the real claude session, the manual conversation IS the context Qwen continues from
  (Qwen already reads transcript history), so sessions are "context aware" for free.
- **Backend implications (this is the meaty one):**
  - Restructure the orchestrator loop to be **mode-aware**: in manual mode it does NOT call the
    brain; it waits for the next user message and injects it (like `resolveAttention`, but
    open-ended and repeatable). In autopilot it runs as today.
  - Add `ClaudeSession.sendUserMessage(text)` (we already own the PTY stdin) and a live
    "message the agent" input bar in the session detail, enabled in manual mode.
  - A `mode: "manual" | "autopilot"` on the session + WS messages to set it and to send a manual
    message; persist the last mode.
  - A guided **new-session wizard** (richer than today's form): pick directory, state the goal,
    choose start-manual vs start-autopilot, set autonomy / gatePolicy / budget with explained
    defaults.

### P2. Adopt existing Claude Code (and maybe Desktop) sessions ★ — DONE (resume + Desktop)

Be able to see and drive sessions that ALREADY exist, not just ones we created.

- **Discover** past/active sessions by scanning `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
  — list them with project path, last-activity time, a one-line summary, turn count.
- **Adopt / resume** one: spawn `claude --resume <id>` (or `--continue`) in a PTY we own, then
  it's a normal session in the cockpit (manual or autopilot).
- **Attach to a live one** the user started in their own terminal — via the Stop-hook attach mode
  that already exists (wire the UI for `/attach`).
- **Claude Desktop sessions — DONE.** Desktop runs embedded Claude Code; descriptors at
  `~/AppData/Roaming/Claude/claude-code-sessions/<id>/<id>/local_*.json` carry a `cliSessionId`
  that points at a transcript under `~/.claude/projects/`. `DesktopDiscovery` + `discoverAll()`
  surface them (deduped with CLI), so they show up in Adopt (DESKTOP/CLI badge, title, archived
  greyed, resumable ones drivable) and feed the learning miner (attributed to the real project via
  `originCwd`). **Deferred:** regular Desktop *chats* (non-agent) live in Chromium leveldb — not
  hooked and not drivable; archived/worktree-removed sessions with no transcript are unrecoverable.
- **Backend:** a `SessionDiscovery` module (scan + parse transcript heads for metadata); a
  dashboard "Existing sessions" browser to import/resume/attach.

### P3. Major UI/UX overhaul ★ — DONE

Rebuilt the dashboard as a **modular Svelte app** (`web/`, Svelte 5 + Vite + TS + Tailwind v4 +
DaisyUI v5; replaced the 900-line monolith) around the experience, not the data:
- Coherent dark "agi" design system (slate + run-green, Inter), clear hierarchy.
- **Fleet at a glance** — status-rail grid + per-status breakdown chips + live count.
- **Great session detail** — live-output terminal (header + live dot), manual message bar,
  autopilot toggle, brain panel, history modal.
- **Decision moments unmissable** — global "N needs you" header alert (jumps to the session),
  pulsing needs-input cards, prominent attention/gate panel.
- **Guided new-session wizard** (Project → Mode → Tune) and **adopt/attach** browsers.
- **Settings** surface (provider, budget, concurrency, defaults — live `updateSettings`).
- **Mobile-friendly** read-only view (single-column page scroll at ≤720px).
Build: `npm run web:build` → `web/dist`, served by the dashboard server. Done across commits
c482a91 → 35ea73a → c6b87b3. **Later:** fleet moved to a collapsible left sidebar to maximize
the content area (commit a7c331b).

### P5. Dispatch — remote mobile access ★ — DONE

Reach and drive the locally-running dashboard from a phone over an exposed port, with basic
auth + rate limiting so only the owner gets in, and a mobile-optimized UI for full remote
control (view state, send commands, approve decisions, start sessions).
- **Token auth** (`src/server/auth.ts`): loopback trusted by default (`trustLocal`), remote
  requires a shared token (Authorization / X-AGI-Token / `?token=` / cookie), constant-time
  compare. **Fail-safe:** no token configured ⇒ remote refused. Gates every `/api/*`, `/attach`,
  `/detach`, `/hook`, and the WS upgrade; static shell stays open. `GET /api/whoami` probe.
- **Rate limiting** (`src/server/rateLimit.ts`): per-IP sliding window for general traffic +
  a stricter brute-force guard on auth failures. Token-first ordering so a valid token always
  recovers a blocked IP (no self-lockout).
- **Frontend**: `auth.svelte.ts` token store + a mobile-first `Login.svelte` gate; token rides
  the WS URL + REST headers; WS reconnect uses backoff + auth re-probe (no stale-token hammering);
  sign-out in Settings.
- **Hardening from a 2-round adversarial review**: fixed a sibling-prefix path-traversal in
  static serving and an unauthenticated `EISDIR` crash-DoS (directory read), added a
  process-level unhandled-rejection guard. `scripts/dispatch-test.ts` covers the auth core.
- **Expose safely**: Tailscale (recommended), Cloudflare Tunnel/ngrok (`trustLocal:false`), or a
  trusted-network port-forward. See `docs/AUTOPILOT_dispatch.md`.

### P4. Design vision — envision the whole dashboard (UX + UI) first ★

Before building P1–P3, design the thing properly — both UX (flows, mental model, interaction
patterns) and UI (layout, visual language). A brilliant design tells us what the backend must do.

- **Mental model:** *mission control for a fleet of AI coding agents.*
- **Primary surfaces to design:**
  1. **Fleet overview** — every session at a glance; status, what each is doing, and LOUD
     "needs you" alerts; quick start/stop/queue; today's budget.
  2. **Session detail** — live terminal, the **manual-message bar + autopilot toggle**, the
     brain's last decision, inline gate/attention prompts, history/timeline, per-session settings.
  3. **New-session wizard** (onboarding, P1) and **Existing-sessions browser** (P2).
  4. **Decision/attention experience** — the most important moment: a session needs a human call.
     Make it unmissable and fast to resolve (dashboard + PiP + notification already exist; design
     the ideal interaction).
  5. **Settings** — provider/model, budget, concurrency, defaults.
- **Key flows to storyboard:** create → seed (manual) → hand to autopilot; get pinged → decide in
  seconds; adopt an existing session; review what an agent did (history/diff).
- **Deliverable:** a design spec + mockups (see the `mission-control` mockup produced alongside
  this roadmap entry). The agreed design then becomes the work-list for P1–P3 and any new backend.

---

## Tier 4 — Autonomy & self-improvement (NEXT PRIORITY after the UX track)

Owner-flagged. These push the orchestrator from "drives sessions" toward "drives long,
self-correcting work that gets better over time." Still local-only, subscription-safe.

### A1. Continue a finished session in the same conversation ★ — DONE (commit a663774)

Once a session is done/stopped/error, resume it IN THE SAME claude conversation (prior context
preserved) with an edited goal / done-criteria / next-instruction, in autopilot or manual.
Captured the run's claude UUID (persisted as `SessionConfig.lastClaudeSessionId`); `RunOptions`
gained `resumeId` + `seedPrompt`; `Supervisor.continueSession()` + `"continue"` WS msg + a
prefilled Continue modal. "Start" stays a fresh conversation.

### A2. Context-window manager — memory-preserving auto-compaction ★ — BUILT (commit c78d2ca); needs live validation

Built `src/policy/context.ts` (`ContextGuard`) + orchestrator integration: after each turn, if
estimated context use ≥ `compactAtPercent`, inject save-handoff → `/compact` → resume-from-handoff.
Trigger estimates use from transcript **bytes/4 ÷ window** (reliable); a best-effort screen-gauge
regex overrides when it matches. Config `AppConfig.contextGuard` (off by default), wired through the
supervisor + daemon; `scripts/context-test.ts` covers the logic. **Still TODO (live):** confirm
`/compact` fires via PTY injection + handoff is re-read; tune the gauge regex to claude's real wording;
then flip `enabled: true`. Original design below.



Long autopilot runs overflow the context. Claude Code auto-compacts, but bluntly. Do it smarter:
**save → compact → resume from memory**, before the window fills.

- **Detect usage** (the crux — needs validation against the live TUI). Options:
  - (a) **Read claude's own context indicator** off the PTY screen (we already VT-emulate it) —
    e.g. the "context left until auto-compact" gauge. Most accurate; primary.
  - (b) **Estimate ourselves** by token-counting the transcript JSONL we already read (heuristic
    ~chars/4, or a real tokenizer) against the model's window. Fallback / provider-agnostic.
  - (c) Ask claude directly via an injected prompt — wasteful, unreliable; last resort.
- **Trigger** at a configurable threshold (e.g. ≥50% used, or ~500K of a 1M window). Between turns,
  a "context guard" runs a mini-sequence:
  1. Inject: *"Save your working state — decisions, open threads, file map, next steps — to a
     handoff memory file (e.g. `.agi/handoff.md`)."*
  2. Run `/compact` (claude's compaction).
  3. Inject: *"Read `.agi/handoff.md` and resume from there."*
- **Config:** `context: { compactAtPercent, handoffPath, enabled }`. **Unknowns:** reliable
  indicator parsing; `/compact` behavior; confirming the handoff is re-read. Needs a live probe
  before committing to detection method (a) vs (b).

### A3. Self-improvement / learning loop ★ — BUILT (commit d7233c9)

Qwen's operator prompt learns the owner's style from past sessions + live corrections, behind a
strict **propose → approve → revert** gate (OFF by default; no-op until a profile is approved).
`src/learning/`: miner (past sessions), liveSignals (derived manual overrides), synthesize (one
local-LLM call → draft), advisory replay-eval, versioned profiles in the `preferences` table
(global ⊕ per-cwd), `LearningService` facade. Injected via `buildSystemPrompt(autonomy, guidance)`
+ a supervisor decide-wrapper. Surface: WS learn* + `/api/learning*` + a "Learn" modal (diff +
advisory eval + approve/revert). `scripts/learn-test.ts` 24/24. **Roadmap follow-ups:** make the
eval strong (LLM-judge + larger held-out) then add `learning.evalGate` so approve rejects Δ<0;
optional thumbs up/down on decisions. **Live validation:** enable `learning`, run sessions, override
Qwen a few times, Synthesize → review → Approve, confirm the next run reflects it, then Revert.
Original design below.



Qwen's operator prompts should get better by learning from the owner's many past Claude Code
sessions AND from live feedback. Local-only; opt-in; review-before-apply so it can't drift badly.

- **A3a — Mine past sessions.** We already scan `~/.claude/projects` (SessionDiscovery, ~51
  sessions). An offline analyzer reads transcripts and distills:
  - an **operator profile** (how the owner phrases instructions, tone, risk tolerance, when they
    stop) injected into `buildSystemPrompt`, and
  - a **few-shot example bank** of (situation → the instruction the owner actually gave), mined
    especially from turns the owner drove by hand.
- **A3b — Feedback-driven evolution.** Strongest signal is the **manual override**: in autopilot,
  when the owner takes the wheel and types something different from what Qwen proposed, that pair
  *(Qwen suggested X, owner did Y)* is a labeled correction — we already distinguish manual vs
  autopilot turns in the transcript. Plus optional thumbs up/down on decisions. Stored in the
  `preferences` table.
- **Synthesis.** Periodically (or on a "Learn" action) summarize the signals — via Qwen itself or
  a bigger local model — into concrete additions to the operator prompt / example bank, surfaced
  for the owner to approve before they take effect. **Auto-evolve** = re-run synthesis as feedback
  accumulates. **Forks:** how aggressive (propose vs auto-apply); per-project vs global profile;
  example-bank vs profile-summary vs (out of scope) fine-tuning.

---

## Tier 0 — Foundation: SQLite persistence ★MUST

Everything good downstream (history, resume, analytics, the attention queue, learning) needs
a durable local store. Today all state is in memory and dies with the process.

- **Engine:** Node 24 ships a built-in `node:sqlite` (synchronous, zero native build) — first
  choice. `better-sqlite3` is the fallback if we need more. A single `agi.db` file in the
  project (gitignored).
- **What to persist:**
  - `sessions` — id, label, cwd, goal, done_criteria, permission_mode, policy, created/updated.
  - `runs` — one per start→stop; session_id, started_at, ended_at, stop_reason, turns, status.
  - `turns` — run_id, n, injected_prompt, assistant_text, duration_ms, gates_handled, files_changed.
  - `decisions` — turn_id, brain action, reason, model, confidence, raw_options (JSON).
  - `attention_requests` — turn_id, kind, summary, options (JSON), chosen_option, resolved_at
    (the heart of the escalation system, Tier 1).
  - `events` — append-only log for the dashboard/PiP feed and audit.
  - `usage` — per-run turn/time counters for rate-limit budgeting.
  - `preferences` — learned per-project choices (Tier 3).
- **Payoffs unlocked:** crash recovery / resume across daemon restarts (restore goals + guard
  counters), full per-project timeline + replay, search across all history, analytics
  ("how many turns did this take", "how often did it need me"), and an audit trail of every
  injected prompt and gate decision.

---

## Tier 1 — The must-haves the owner named

### 1. Always-on status window via Chrome Picture-in-Picture ★MUST

A compact, always-on-top panel that shows every active session at a glance even when the
dashboard tab is hidden behind other work.

- **Tech:** the **Document Picture-in-Picture API** (`documentPictureInPicture.requestWindow()`)
  — Chrome-only, needs a user gesture to open. Pops a live DOM panel into an OS-level
  always-on-top window. It subscribes to the same WebSocket feed as the dashboard.
- **Shows per session:** label + a bold status light — **running / stopped / done / error /
  NEEDS-INPUT** — plus turn count and a tiny activity pulse.
- **NEEDS-INPUT must be loud:** color flip + flash + (optional) sound, and the chip is
  clickable to jump straight to that session in the full dashboard.
- **Companion:** desktop notifications (Notification API) when a session finishes or flips to
  NEEDS-INPUT, so it surfaces even if the PiP window is closed.
- **Depends on:** the status model from Tier 1.2 (so "needs input" is a real, distinct state).

### 2. Human-decision escalation ("attention") system ★MUST

The core intelligence upgrade. Today the brain auto-answers *everything*. We must separate
two cases:

- **Auto-handle (Quinn/Qwen decides):** routine "do you want to continue?", "shall I proceed
  with X?", obvious next steps within the stated goal.
- **Escalate to the human:** genuine decisions — irreversible/destructive actions, ambiguous
  requirements, choices with taste/business tradeoffs, anything needing credentials or info
  only the user has, or anything outside the agreed goal/scope.

How it should work:

- A **classifier pass** (the brain, or a dedicated cheap-model judge) labels each turn-end as
  *auto* or *escalate*, with a reason and a confidence score. Low confidence also escalates.
- On escalate: **pause the session** (do NOT inject), set status → NEEDS-INPUT (lights up the
  PiP window + notification), and have **Qwen generate 2–4 concrete options** — each with a
  one-line rationale and what it would do next — plus an always-present "write your own".
- The user picks an option (from dashboard or PiP); the chosen option becomes the injected
  prompt and the session resumes. Everything (question, options, choice) is logged to
  `attention_requests` for later learning.
- **Timeout policy (configurable):** hold indefinitely (default), or after N minutes pick the
  safest option / stop. Never silently do something risky.
- **Depends on:** SQLite (Tier 0), status model, and ties directly into per-gate safety (Tier 2).

---

## Tier 2 — High-value

### 3. Per-gate safety policy (replaces blanket auto-confirm)
Today every TUI gate is auto-confirmed at its default. Instead, classify gates: auto-approve
safe ones (file edits, reads), **escalate dangerous ones** (shell `rm`/`git push --force`,
network calls, anything touching secrets) through the attention system. This is the safety
backbone for unattended runs.

### 4. Rate-limit / usage budgeting
The real cost is the subscription's 5-hour/weekly cap, not dollars. Track turns + wall-clock
per run in SQLite, estimate consumption, warn as a cap approaches, and hard-stop before
blowing it. Surface "budget remaining" in the dashboard.

### 5. Smarter brain context
Move from raw last-N history to a **rolling summary** of the project so far + the recent turns,
and feed in **git status / diff** of the project as context. Optionally a **multi-model brain**:
a small fast local model for routine decisions, a bigger one for escalation-option generation.
Add **self-confidence scoring** that feeds the escalation classifier.

### 6. Observability in the dashboard
Backed by SQLite: a full **per-session timeline / transcript replay**, a **diff viewer** (what
files changed each turn, via git), cross-session **search**, and a **metrics view** (turns,
time, stop reasons, "intervention rate"). Live event log with filtering.

### 7. Multi-session orchestration
A **concurrency cap** (don't run 8 sessions and nuke the rate limit), a **queue/scheduler**
(run N at a time, priorities), and optional **session dependencies** (project B starts when A
finishes). **Session templates** — reusable goal+done-criteria+policy presets for common tasks.

### 8. Stuck / oscillation detection
Beyond ping-pong: detect "no files changed for N turns", repeated identical errors, or the
agent re-reading the same files in circles → pause and escalate instead of burning turns.

---

## Tier 3 — Powerful extras

### 9. Hook-attach maturity
Dashboard **attach/detach panel** (routes already exist), **auto-discover** running `claude`
sessions on the machine and offer to attach, and detect NEEDS-INPUT in hand-driven sessions too.

### 10. Git integration
Per-turn **snapshot commits** (so you can roll back any agent step), branch/diff awareness,
and optional **auto-open a PR / draft** when a session hits its done-criteria.

### 11. Learning loop
Thumbs up/down on brain decisions and escalation outcomes → tune the operator prompt over time.
Store **per-project preferences** (the user always chooses X for Y) in SQLite and let the brain
reuse them so it escalates less over time.

### 12. Goal intake assistant
Before a run, detect a vague goal/done-criteria and have the brain ask 2–3 sharpening questions
up front (better goal = fewer mid-run escalations).

### 13. Operator personas
Per-session policy knobs: how autonomous, what it may auto-decide vs always escalate, tone,
risk tolerance. A "cautious" persona escalates more; an "aggressive" one fewer.

### 14. Reliability hardening
Auto-pause if the local LLM goes unreachable (model unloaded), transient-error retries,
per-turn timeout tuning, and a global **kill-switch / pause-all**.

---

## Suggested build order

1. **SQLite layer (Tier 0)** — unblocks almost everything; do first.
2. **Status model + attention/escalation system (1.2)** — the core value jump.
3. **PiP status window (1.1)** — rides on the status model; high daily-use payoff.
4. **Per-gate safety (3)** + **usage budgeting (4)** — makes unattended runs safe.
5. Then observability, orchestration, and the Tier 3 extras as appetite allows.
