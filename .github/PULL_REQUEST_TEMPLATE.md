<!-- Thanks for contributing! Keep PRs focused on one logical change. -->

## What

<!-- A short summary of the change. -->

## Why

<!-- The problem this solves / the motivation. Link issues: "Closes #123". -->

## How it was tested

<!-- Which of these did you run? Paste output if relevant. -->

- [ ] `npm run typecheck`
- [ ] `npm run web:check`
- [ ] `npm test` (deterministic, offline)
- [ ] `npm run build`
- [ ] Live smokes (`npm run pty-smoke` / `npm run smoke`) — needed if this touches the PTY,
      session driver, brain, or gate handling
- [ ] Manually exercised in the dashboard

## Safety invariant

<!-- The project must stay local-only and subscription-safe. -->

- [ ] This change does **not** add the Agent SDK, an API key path, or a non-loopback brain
      endpoint, and does not weaken the billing preflight (`src/util/env.ts`) or the loopback
      provider check (`src/config.ts`).
- [ ] If it touches env handling, spawning, provider config, or the dispatch surface, I added
      or updated a test proving the relevant guard still fires.

## Docs

- [ ] Updated `README.md` / `docs/` / `config.example.json` notes if behavior or config changed.
- [ ] Added a `CHANGELOG.md` entry under **Unreleased** (if user-facing).
