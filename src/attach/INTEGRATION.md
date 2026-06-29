# Hook-attach mode — integration guide

This wires the new `AttachManager` into the daemon so you can drive a `claude`
session **you started by hand** in your own terminal (not a daemon-owned PTY).

Flow:

```
your hand-started claude finishes a turn
  → Stop hook (hook/stop-hook.mjs) fires, POSTs the hook payload to the daemon
    → POST /hook → attachManager.handle(body)
      → read last assistant msg → guards → local brain → {action, prompt, reason}
    → hook prints {"decision":"block","reason":<prompt>} → claude continues
       (or no output → claude stops)
```

`AttachManager` is fully decoupled: you inject `brain` and `readLastMessage`, so
nothing in `src/attach/` imports the brain or transcript reader directly.

---

## 1. Mount `POST /hook` in `src/server/index.ts`

The current server only serves `/`, `/index.html`, `/favicon.ico`. Add a branch
that reads the JSON request body, calls `attachManager.handle(body)`, and returns
the JSON result. Sketch (drop into the existing `http.createServer` handler):

```ts
import { AttachManager } from "../attach/attachManager.js";
import { decideNextStep } from "../brain/decide.js";
import { readLastAssistantMessage } from "../transcript/reader.js";
// `sup` / `cfg` already exist in main(); LocalLLM is available via the supervisor
// or construct one from cfg.provider.

// Construct ONCE in main(), after cfg is loaded (see section 2 for deps):
const attachManager = new AttachManager({
  brain: async ({ goal, doneCriteria, lastAssistantText, turnNumber }) => {
    // Adapt decideNextStep's (llm, session, lastText, turnNumber) signature.
    const session = { id: "attached", cwd: "", goal, doneCriteria };
    const d = await decideNextStep(llm, session, lastAssistantText, turnNumber);
    return { action: d.action, prompt: d.prompt, reason: d.reason };
  },
  readLastMessage: (cwd, sessionId) => readLastAssistantMessage(cwd, sessionId),
  limits: cfg.limits,
});

// In the request handler (handler must be async, or use a .then chain):
if (req.method === "POST" && req.url === "/hook") {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ action: "stop", prompt: null, reason: "bad json" }));
      return;
    }
    const result = await attachManager.handle(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });
  return;
}
```

`handle()` never throws, so the route can't 500 from brain/transcript errors —
it returns a safe `{action:"stop"}` instead.

---

## 2. Construct AttachManager with the REAL deps

### `brain` — wraps `decideNextStep`

Current signature (`src/brain/decide.ts`):

```ts
decideNextStep(
  llm: LocalLLM,
  session: SessionConfig,        // needs at least { goal, doneCriteria }; also id, cwd
  lastAssistantText: string,
  turnNumber: number,
  history?: Array<{ role: "user" | "assistant"; text: string }>,
): Promise<Decision>             // Decision = { action, prompt?, reason }
```

The injected `brain` receives `{ goal, doneCriteria, lastAssistantText,
turnNumber }` and must return `{ action, prompt?, reason }`. Build a throwaway
`SessionConfig`-shaped object from `goal`/`doneCriteria` and pass it through (see
sketch above). `Decision` and `AttachBrainResult` are structurally identical, so
you can return `d` directly.

**You need a `LocalLLM` instance.** Construct `new LocalLLM(cfg.provider)` in
`main()` (it's already imported indirectly via the supervisor; import it from
`../brain/provider.js` if not in scope).

### `readLastMessage` — is `readLastAssistantMessage`

`readLastAssistantMessage(cwd: string, sessionId: string): Promise<string>` from
`src/transcript/reader.ts` matches the `ReadLastMessage` type **exactly** — pass
it directly (or as a thin arrow as above).

> Optional richer context: `readRecentMessages(cwd, sessionId)` exists if you
> later want to feed `history` into `decideNextStep`. The attach `brain` shape
> doesn't carry history today; extend `AttachBrainInput` if you want it.

### `limits`

`AttachLimits` = `{ maxTurns, maxWallClockMin, pingPongThreshold }`, structurally
identical to `Limits` in `src/types.ts`. Pass `cfg.limits` straight through.
Guards are **per attached session** and created in `register()`; re-registering a
session resets its turn/time/ping-pong counters.

---

## 3. Register the Stop hook in Claude settings

The user adds a Stop hook pointing at the absolute path of `hook/stop-hook.mjs`.
In `~/.claude/settings.json` (or a project `.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node C:\\Users\\panda\\Desktop\\AGI\\hook\\stop-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

- Use the **absolute** path to `stop-hook.mjs`. On Windows, escape backslashes in
  JSON (`\\`), or use forward slashes.
- The hook talks to `http://localhost:4317` by default. If your dashboard runs on
  a different port (`cfg.port`), set the env var **in the environment claude runs
  in** before launching it:
  - PowerShell: `$env:AGI_DAEMON_URL = "http://localhost:5000"; claude`
  - bash: `AGI_DAEMON_URL=http://localhost:5000 claude`
- The hook fails open: if the daemon is down or slow (30s timeout), it exits
  silently and your session stops normally — it will never block or crash claude.

---

## 4. Registering an attached session

Before a hand-started session can be driven, the daemon must know its
`session_id`, `goal`, and `doneCriteria` (call `attachManager.register(id, {goal,
doneCriteria})`). The `session_id` must match the one the user's claude runs
under — start claude with a known id: `claude --session-id <uuid>` and register
that same uuid.

Intended UI flow (you wire this):

1. Dashboard gains an **"Attach session"** action: the user pastes/generates a
   `session_id` and enters `goal` + `doneCriteria`.
2. That posts to a new route (e.g. `POST /attach`) which calls
   `attachManager.register(session_id, { goal, doneCriteria })`.
3. The user runs `claude --session-id <that id>` in their terminal (with the Stop
   hook registered). From the first turn-end on, the daemon drives it.
4. A **"Detach"** action calls `attachManager.unregister(session_id)`.

Until a `/attach` route exists, you can register sessions at boot from
`config.json` (treat configured sessions as pre-attached) for testing.

---

## Assumptions to reconcile

- **`session_id` matching.** The whole mechanism assumes the id the user's claude
  runs under (`--session-id`) equals the id you `register()` and the
  `session_id` claude sends in the hook payload. If a session isn't registered
  under the exact id, `handle()` returns stop. Decide how the UI guarantees this
  (force `--session-id`, or look the id up from the transcript folder).
- **No history passed to the brain today.** `AttachBrainInput` carries only the
  last assistant message (parity with the daemon-owned path's minimal context).
  Extend it + the adapter if you want `readRecentMessages` history.
- **Turn counting.** `handle()` calls the brain with `turnCount + 1`, then runs
  `guards.check(prompt)` (which increments). So the brain sees the turn number it
  is authorizing, and a stop decision does **not** burn a turn. Confirm that's
  the accounting you want.
- **Single daemon, localhost only.** The hook POSTs to one `AGI_DAEMON_URL`. This
  stays local-only / subscription-safe — no API key, no token billing; the
  attached claude draws from the user's normal subscription exactly as if typed
  by hand.
- **Concurrent hooks.** If you attach several sessions, multiple `/hook` POSTs can
  arrive concurrently; each keys off its own `session_id`/`Guards`, so they don't
  interfere. The `Map` access is synchronous and safe under Node's single thread.
