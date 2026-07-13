# Autopilot contract — brain resilience (stop the "brain stops" errors)

Invoked 2026-07-13: "all phases in turns, commit each stage." Branch: `autopilot/brain-resilience`.

Root-cause analysis (this session, from live `Desktop\AGI\agi.db`): 31 runs died on
`claude exited (code 1)`, ~10 on `screen frozen … never became ready` — most of those
turns had actually COMPLETED (screen showed `✻ Worked for 24m 28s · 1 shell still
running` + idle footer the regexes don't know). Structural flaws: turn-end detection is
screen-regex-only, and any misread throws → run dies → nothing restarts it.

## Definition of done (checklist)

### Phase 1 — stop the bleeding (commit 1)
- [ ] `state.ts`: recognize current idle footers (`bypass permissions on`, `N shell(s)`,
      `← for agents`, `↓ to manage`, completed-spinner `✻ <Verb>ed for Xm Ys`) as READY;
      background shells do NOT block turn-end.
- [ ] Feedback survey: dismiss with `0` (fall back to Esc), not Esc alone.
- [ ] Verified submission: bracketed-paste the prompt, verify work actually started,
      re-send Enter (bounded) if the input was swallowed. Multi-line prompts safe.
- [ ] Exit diagnostics: on claude exit, error includes exit code + last screen lines;
      claude version logged at spawn.
- [ ] Unit tests for all new classifications + submit logic where testable offline.

### Phase 2 — recovery ladder (commit 2)
- [ ] Transcript ground truth (`reader.ts`): file activity (mtime/size) = progress;
      last-entry-is-final-assistant-text + quiet = turn over.
- [ ] `waitForReady` ladder instead of fail-fast: transcript check → repaint nudge
      (PTY resize) → (Phase 3: Qwen triage) → recoverable timeout.
- [ ] Orchestrator turn recovery: on recoverable timeout / claude exit, kill + respawn
      `--resume <same conversation>`, detect whether the reply already landed (transcript
      offset) and only re-inject if not. Bounded attempts + backoff. New `recovery` event.
- [ ] Supervisor auto-heal: run ends `error` → auto-continue with backoff + attempt cap
      (skip Auth/Cwd errors); notify only when exhausted. Config knob in `reliability`.
- [ ] Tests: transcript liveness parsing, recovery decision logic.

### Phase 3 — leverage Qwen (commit 3)
- [ ] `brain/triage.ts`: Qwen classifies an unrecognized/frozen screen tail
      (ready/working/gate/menu/survey/error) + suggests ONE safe key (enter/esc/digit
      only). Wired into the waitForReady ladder via injectable hook.
- [ ] Brain JSON self-repair: one corrective retry before the fail-safe stop.
- [ ] Escalation timeout for `autonomous`-persona sessions: auto-pick the first option
      after N min (config `brain.escalationTimeoutMin`, default 20; 0 = off) + notify.
- [ ] Tests with stubbed LLM.

### Phase 4 — headless engine (commit 4)
- [ ] `session/headlessSession.ts`: drives `claude -p --output-format stream-json`
      per turn with `--session-id`/`--resume` chaining (subscription-auth, no API key,
      no PTY, no screen scraping). Prompt via stdin.
- [ ] Engine dispatch: `SessionEngine` gains `"claude-headless"`; orchestrator accepts a
      session factory; supervisor routes the new engine through it.
- [ ] Tests: stream-json parsing (offline fixtures).

### Verification ladder (commit 5 if fixes needed)
- [ ] `npm run typecheck` clean.
- [ ] Full `npm test` chain passes (including new tests wired into it).
- [ ] Multi-agent adversarial review of the diff; real findings fixed and re-verified.
- [ ] PR opened/updated on `autopilot/brain-resilience` with decision log.

## Decision log
(appended as decisions are made — see AUTOPILOT_brain_resilience_DECISIONS.md)
