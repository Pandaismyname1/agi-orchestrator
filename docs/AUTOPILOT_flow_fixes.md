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

## Decision log
- (to be filled as decisions are made)
