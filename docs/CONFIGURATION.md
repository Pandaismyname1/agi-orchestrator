# Configuration reference

All runtime configuration lives in **`config.json`** at the repo root (override the path with
`$AGI_CONFIG`). Copy [`config.example.json`](../config.example.json) — which carries an inline
`_note` for every block — to `config.json` and edit it. A machine-readable
[`schemas/config.schema.json`](../schemas/config.schema.json) validates the file in editors that
support JSON Schema (VS Code picks it up via the `$schema` key in the example).

> **Underscore keys** (`_note`, `_brain_note`, …) are human comments; the loader ignores them.
> **`$schema`** is ignored by the loader too — it's only for editor validation.

Only two things are required: **`provider`** (a local brain) and at least one **`session`**.
Everything else has a sane default or is off.

---

## Minimal config

```jsonc
{
  "$schema": "./schemas/config.schema.json",
  "provider": {
    "baseUrl": "http://localhost:11434/v1",  // Ollama; LM Studio = :1234/v1
    "model": "qwen3:8b"                        // must match what the server reports
  },
  "sessions": [
    {
      "cwd": "C:\\path\\to\\project",
      "goal": "Build a one-page marketing site: hero, menu, hours, contact.",
      "doneCriteria": "index.html renders all sections with no broken markup.",
      "permissionMode": "acceptEdits",
      "autonomy": "balanced"
    }
  ]
}
```

---

## Top-level blocks

| Key | Type | Default | Purpose |
| --- | --- | --- | --- |
| `provider` * | object | — | The every-turn brain (local LLM). **Loopback URL required.** Keep it fast — it runs once per turn. |
| `escalationProvider` | object | reuse `provider` | Optional second **local** model used only to regenerate escalation options. |
| `sessions` * | array | — | The sessions to drive (≥ 1). See [Session](#session). |
| `limits` | object | see below | Per-run guard rails. |
| `port` | int | `4317` | Dashboard HTTP port. |
| `dbPath` | string | `./agi.db` | SQLite store path. |
| `budget` | object | off | Daily turn/minute caps across all sessions. |
| `maxConcurrent` | int | no cap | Max sessions running at once; extras queue. |
| `defaults` | object | — | Defaults for newly created sessions (permissionMode, autonomy). |
| `contextGuard` | object | off | Memory-preserving compaction for long runs. |
| `learning` | object | off | Self-improvement loop (approve-gated). |
| `dispatch` | object | local-only | Remote access: token auth + rate limiting. |
| `usageGuard` | object | on | Pause/resume on Claude's real `/usage` limits. |
| `brain` | object | — | Decision gating (confidence, rolling summary, escalation timeout). |
| `templates` | array | — | Reusable session presets. |
| `webhooks` | array | — | Outbound Slack/Discord/JSON on lifecycle events. |
| `reliability` | object | defaults | Self-healing: retries, health-poll, auto-heal. |
| `logging` | object | console | Level + optional rotating file. |
| `registry` | object | off | Remote template registry (template data only). |
| `automations` | array | — | Reactive rules (event → start/stop/notify). |
| `quietHours` | object | off | Silence notifications during a daily window. |
| `automationChainCap` | int | `8` | Loop guard for cascading automations. |
| `workflowDepthCap` | int | `10` | Park very deep dependency chains for manual review. |

\* required.

---

## Session

The unit of work. Required: `cwd`, `goal`, `doneCriteria`.

| Key | Values | Notes |
| --- | --- | --- |
| `id` | string | Stable id (auto-generated if omitted). |
| `engine` | `claude` · `claude-headless` · `opencode` | Which agent drives it. `opencode` requires the `opencode` block. |
| `cwd` | path | The project directory. **Must exist inside the container when using Docker.** |
| `goal` | string | First prompt to claude; anchors the brain. |
| `doneCriteria` | string | The brain's STOP test. |
| `permissionMode` | `default` · `acceptEdits` · `auto` · `bypassPermissions` | Looser = fewer gates but more autonomy. `default` is needed for `gatePolicy` to see bash prompts. |
| `gatePolicy` | `guard` · `auto` | `guard` (default) escalates dangerous gates & default-denies when unattended. |
| `autonomy` | `cautious` · `balanced` · `autonomous` | Operator persona — how readily the brain escalates. |
| `startMode` | `manual` · `autopilot` | `manual` lets you seed context first, then flip. |
| `limits` | object | Per-session override of global `limits`. |
| `dependsOn` | string[] | Workflow prerequisites (must reach `done` first). |
| `schedule` | object | `everyMinutes` and/or `dailyAt` ("HH:MM"). |
| `autoPr` | object | Open a PR on done (`mode`: draft/ready). Needs a git repo + `gh`. |
| `notify` | object | Per-session mute / event allow-list. |
| `resumeId` | string | Adopt an existing claude session by id. |

### `limits` (per-run guards)

| Key | Default | Meaning |
| --- | --- | --- |
| `maxTurns` | `25` | Forced stop after N turns. |
| `maxWallClockMin` | `60` | Forced stop after N minutes. |
| `pingPongThreshold` | `3` | Stop if the brain repeats near-identical prompts. |
| `stuckTurns` | `4` | Escalate if no files change for N turns (0 = off). |

---

## Safety-critical settings

These interact with the subscription-safety guarantee — read [SECURITY.md](../SECURITY.md).

- **`provider.baseUrl` / `escalationProvider.baseUrl`** must be **loopback**
  (`localhost`/`127.0.0.1`/`::1`). A remote URL is refused at load time.
- **`permissionMode: "bypassPermissions"`** runs fully unattended with no gates — use only when
  you trust the goal and the working directory.
- **`dispatch.token`** (or `$AGI_DISPATCH_TOKEN`) gates all remote access. With none set, remote
  requests are refused. Prefer a TLS tunnel; set `dispatch.trustLocal: false` behind a local
  tunnel so the token is still required.
- **`opencode.allowPaidProvider`** is the only way to let a session use a non-local provider,
  and it's an explicit opt-in.

---

## Environment variables

| Var | Effect |
| --- | --- |
| `AGI_CONFIG` | Path to the config file (default `config.json`). |
| `AGI_DB` | SQLite store path (overrides `dbPath`). |
| `AGI_PORT` | Dashboard port for the launcher (`scripts/launch.mjs`). |
| `AGI_DISPATCH_TOKEN` | Remote-access token (wins over `dispatch.token`). |
| `AGI_OPEN` | Set by the launcher to auto-open the browser; unset in headless/Docker. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL` | **Presence hard-aborts startup** (billing trap). |
| `ANTHROPIC_BASE_URL` | Aborts unless it's the official endpoint. |

---

## Tips

- **Model choice matters.** The brain runs once per turn — pick a fast instruct model.
  `qwen3.5:9b` benchmarked ~2–3 s/decision at ~88% on the decision eval; 30B+ models were far
  slower without clearly better decisions. See `scripts/brain-eval.ts`.
- **Long runs:** enable `brain.rollingSummary` and/or `contextGuard` so the brain and the agent
  don't drown in history.
- **Fleets:** set `maxConcurrent` and a `budget` (or rely on `usageGuard`) so a fleet can't
  hammer your weekly cap.
- Full field-level constraints and defaults are in
  [`schemas/config.schema.json`](../schemas/config.schema.json).
