# AGI orchestrator — roadmap / feature backlog

Planning doc. Nothing here is implemented yet — it's the list of features that would make
this the most powerful version of itself. Tiers are rough priority. The three the owner
explicitly flagged as must-haves are marked **★MUST**.

Guiding principle stays fixed: **local-only, subscription-safe** (no Agent SDK, no API key,
billing preflight). Every feature below must respect that.

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
