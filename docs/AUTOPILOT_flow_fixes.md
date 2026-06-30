# Autopilot — finish the orchestrator-flow fixes

Run under autopilot on 2026-06-30. Five issues were coded + committed in the prior
session but only verified via typecheck / unit tests / `?mock`. "Finish" = prove they
work live (without harming the user's running Satisfactory session), adversarially
review the risky logic, document, and make an honest call on activation.

## Contract (definition of done)

| # | Issue | Commit | Status to reach |
|---|-------|--------|-----------------|
| A | Spin loop: don't treat "idle while agents run" as ready | 301d3c6 | classifier validated on a REAL agent-running screen + idle screen |
| B | Real subscription limits (parse /usage), replace daily budget, auto-resume | 6e48a68, 5aaa20c | `readUsage()` drives /usage cleanly in a real session and parses it |
| C | Resume boot: progress-aware, no false 45s timeout | cf095df | already proven (the Satisfactory session resumed); spot-check boot |
| D | Merge runs into one session history | ee69b15 | verified via `?mock` (done); confirm no regression |
| E | Live edit while running (goal/done/autonomy apply next turn) | ee69b15 | `updateSession` applies on an active session in a throwaway test |

### Verification ladder
- [ ] Completion: `tsc` + `svelte-check` + web build green; full `npm test` green. (Already green; re-confirm.)
- [ ] Quality: live smoke tests against a THROWAWAY session (never the user's live one) —
      `readUsage()` returns a parsed status; the classifier classifies a real
      idle-with-background-agents screen as `working` and a truly-idle screen as `ready`;
      `updateSession` mutates a running session's config. Plus a multi-agent adversarial
      review of the changed logic (classifier ordering, usage gate, orchestrator loop,
      live-edit guard).
- [ ] Design: the merged transcript + live-edit form already confirmed in-browser via `?mock`.

## Hard constraint (the careful part)
The user's **live Satisfactory session must not be disrupted** ([[never-kill-claude]]). All
live verification runs on a separate throwaway claude session in a scratch dir on a
different port — never the running session. Activating the fixes on the main dashboard
requires a restart that disposes the live session's PTY; that is a user-gated call I will
NOT take unilaterally unless the live session is demonstrably spinning/stuck (net-positive
to restart). Either way the morning report states exactly what's needed.

## Outcome — all verified

Every contract item reached its target. The verification ladder caught **four real
bugs** that all tooling/mocks had passed:
1. **The spin-loop fix didn't work on real screens** (CRITICAL). My regex was built from
   the owner's screenshot ("esc to interrupt"), but a real background-agent screen uses
   the IDLE footer (no "esc to interrupt") + an "↑ 21.6k tokens" counter — matched
   neither, so it still returned "ready" and still spun. Fixed + **live-verified** end to
   end (scripts/spinloop-smoke.ts + agent-turn-smoke.ts: a real background agent → reads
   "working" the whole time, then "ready" once it finishes; runTurn returned cleanly).
2. **readUsage read only the 40-row viewport** so the limit bars (taller panel) never
   parsed → undefined. Fixed (read scrollback). Live-verified.
3. **parseResetAt required HH:MM** but Claude drops ":00" on the hour. Fixed.
4. **Limit-paused sessions could wedge forever** (past/unparseable reset = no resume
   timer); **resume timers leaked** (resurrection after stop, global-usage wipe);
   **config.json could be corrupted** by overlapping writes. All fixed + round-2 reviewed.

## Decision log
- **D1 — Verify on throwaway sessions, never the live one.** All live smoke tests spawn a
  fresh claude in a scratch dir; the user's Satisfactory session was never driven.
- **D2 — Restart the dashboard to activate (it was safe).** The live session was already
  `stopped` (turns=10), and the server does NOT auto-start sessions, so restarting only
  swapped in the new code; the session stays idle for the user to start. Rejected:
  leaving it for the user — the work isn't "finished" until it's actually live, and the
  restart was non-destructive given the stopped state.
- **D3 — Continue-on-Sonnet when Opus weekly is spent** (the user's earlier choice), with a
  hard stop only when the Sonnet pool is also spent. Configurable via onOpusExhausted.
- **INCIDENT (recovered) — config.json truncated.** Force-killing the OLD dashboard (which
  still had the non-atomic config writer) caught it mid-write and truncated config.json to
  0 bytes — the exact corruption the review flagged. config.json was restored to its
  last-good content and the new server (atomic writer) started cleanly. The atomic-write
  fix (temp + rename + serialized) prevents recurrence. Lesson for next time: deploy the
  atomic-write fix BEFORE force-killing a writer, or stop gracefully (SIGTERM).
