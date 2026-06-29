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

### P1. Onboarding + context-aware sessions + manual/autopilot toggle ★

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

### P2. Adopt existing Claude Code (and maybe Desktop) sessions ★

Be able to see and drive sessions that ALREADY exist, not just ones we created.

- **Discover** past/active sessions by scanning `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
  — list them with project path, last-activity time, a one-line summary, turn count.
- **Adopt / resume** one: spawn `claude --resume <id>` (or `--continue`) in a PTY we own, then
  it's a normal session in the cockpit (manual or autopilot).
- **Attach to a live one** the user started in their own terminal — via the Stop-hook attach mode
  that already exists (wire the UI for `/attach`).
- **Claude Desktop sessions** — Desktop keeps agent-mode sessions under
  `~/AppData/Roaming/Claude/local-agent-mode-sessions/…`; different format, may not be drivable.
  Mark **investigate / if-possible**; don't block the Claude Code path on it.
- **Backend:** a `SessionDiscovery` module (scan + parse transcript heads for metadata); a
  dashboard "Existing sessions" browser to import/resume/attach.

### P3. Major UI/UX overhaul ★

Rebuild the dashboard around the experience, not the data. Driven by the design vision (P4): a
coherent design system, clear information hierarchy, the fleet at a glance, a great session
detail (live terminal + manual input + autopilot toggle + brain panel + history), and the
needs-you / decision moments made unmissable. Mobile-friendly read-only view a plus. This is the
*build*; P4 is the *design* that specifies it.

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
