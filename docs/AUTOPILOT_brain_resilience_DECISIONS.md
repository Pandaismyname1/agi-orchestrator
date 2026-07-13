# Decision log — brain resilience autopilot run (2026-07-13)

Autonomous calls made during the unattended run, newest last. Each entry: the
decision, why, what was rejected, and what a reviewer should double-check.

## D1 — Background shells do not block turn-end
**Decision:** a screen showing `N shell(s) still running` with an idle prompt counts as
READY. **Why:** the shells are typically dev servers Claude started with
`run_in_background` — they never exit; 3 of the last 4 run deaths were exactly this
(turn complete, `1 shell still running`, 8-minute freeze, death). The final assistant
message is already in the transcript at that point. **Rejected:** adding shells to
WORKING_RE — would convert the 8-min death into a 90-min hang. **Double-check:** if a
turn's real work runs inside a background shell, the brain may prompt "too early";
the transcript ground-truth check (Phase 2) plus the brain's own judgment mitigate.

## D2 — Blocked background AGENTS still block turn-end
**Decision:** keep `Waiting for N background agent` as WORKING. Agent fan-outs are
finite work (unlike servers) and prompting mid-fan-out confuses the turn.

## D3 — Survey dismissal alternates 0 and Esc
**Decision:** first dismissal attempt sends `0` (matches the observed `0: Dismiss`
build), subsequent attempts alternate Esc/0, bounded. **Why:** DB shows an 8-minute
Esc-spam death on the survey screen. Alternating covers both TUI builds.

## D4 — Recovery is transcript-first
**Decision:** before declaring a frozen screen dead, consult the transcript JSONL:
recent file growth = progress; last entry is final assistant text + file quiet =
turn OVER (success, not error). **Why:** the transcript is the only stable,
version-proof signal; the screen is decoration. **Rejected:** more regex tuning as
the primary fix — it loses the arms race with every Claude Code release.

## D5 — Respawn+resume re-injection guarded by transcript byte offset
**Decision:** when a turn is recovered by kill+`--resume`, the orchestrator records the
transcript byte size before injection; after resume it re-injects the SAME prompt only
if no assistant reply appeared after that offset. **Why:** blind re-injection would
double-execute work; blind skip would stall the turn. **Double-check:** offset
comparison assumes Claude appends to the same transcript file on resume (it does — the
conversation id is unchanged).

## D6 — Auto-heal defaults ON, 3 attempts, exponential backoff, not for Auth/Cwd errors
**Decision:** `reliability.autoHeal` defaults to true with `autoHealMaxAttempts: 3`
(backoff 2min → 4min → 8min; counter resets after a healthy 15-minute run). 401s and
bad-cwd errors don't heal (they need the human). **Why:** the user's stated goal is
"have it continue autonomously"; 31 dead runs were restart-and-it-worked cases.
**Double-check:** if a failure is deterministic at boot, heal burns 3 quiet attempts
before notifying — acceptable (≈14 min), but tune `autoHealMaxAttempts` to taste.

## D7 — Qwen triage may only press Enter, Esc, or a single digit
**Decision:** the Qwen screen-triage fallback can suggest exactly one keystroke from
{enter, esc, 0-9}; anything else is ignored. It never types text. **Why:** a local 9B
model must not be able to inject free-form instructions into a live session; digits
cover surveys/pickers, Enter/Esc cover gates/menus.

## D8 — Escalation timeout only for `autonomous` persona
**Decision:** `brain.escalationTimeoutMin` (default 20, 0=off) auto-picks the FIRST
escalation option after the timeout — but only for sessions whose autonomy persona is
"autonomous". Cautious/balanced sessions still wait for the human indefinitely.
A pending DANGEROUS-GATE approval under the same persona times out to **deny** (the
safe direction — claude routes around it); a gate is never auto-approved.
**Why:** an autonomous-persona overnight run parking forever on a question defeats the
mode; the first option is by convention the brain's recommended path. A notification
fires either way. **Double-check:** if you dislike auto-picks, set it to 0.

## D9 — Headless engine is opt-in per session, PTY stays the default
**Decision:** new engine `"claude-headless"` drives `claude -p --output-format
stream-json` with `--session-id`/`--resume` chaining; existing sessions keep the PTY
engine. **Why:** print mode eliminates the whole screen-scraping failure class but
gives up interactive gate mediation and live TUI view; per-session choice lets both
coexist. Subscription-safety unchanged: same CLI binary, same login, `scrubbedEnv()`
still enforced, no API key involved.

## D10 — `unknown`+static screens get the ladder, not a bigger regex zoo
**Decision:** `IDLE_RE` gains only the well-attested current footers; everything else
unrecognized routes through transcript check → repaint nudge → Qwen triage → resume.
**Why:** the ladder is version-proof; regexes are an optimization, not the safety net.
