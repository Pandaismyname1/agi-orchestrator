/**
 * OpenCodeSession (PROTOTYPE) — drive ONE OpenCode session over the `opencode
 * serve` HTTP API, the way `ClaudeSession` drives a Claude Code PTY. Unlike the
 * Claude driver (which owns a pseudo-terminal and scrapes the TUI), OpenCode
 * exposes a real HTTP server, so this talks to it directly: no emulator, no
 * screen classification.
 *
 * The relevant API (learned from a live `opencode serve`, spec version 0.0.3):
 *   POST /session                     { title? }            -> Session { id, ... }
 *   POST /session/{id}/message        { model:{providerID,modelID}, agent?, parts }
 *                                      BLOCKS until the turn is idle, then returns
 *                                      the assistant message { info, parts }.
 *   GET  /event                       SSE stream of:
 *        message.part.updated  { part:{ type:"text"|"tool"|…, text?, … } }
 *        session.status        { status:{ type:"busy" | … } }   (idle when not busy)
 *        permission.updated    { properties: <permission> }     (agent wants approval)
 *   POST /session/{id}/permission/{permissionID}  { response:"once"|"always"|"reject" }
 *   POST /session/{id}/abort          cancel the in-flight turn.
 *
 * The turn POST is synchronous — it does not return until the turn goes idle. If
 * the agent asks for a permission mid-turn it BLOCKS on that request, so the
 * permission MUST be answered on a concurrent channel. That's why `start()` opens
 * a persistent `/event` reader: it answers permission requests (via `onPermission`)
 * while `runTurn()`'s POST is still in flight, which is what lets the turn finish.
 *
 * This is a prototype: it proves create → send → permission loop. Wiring it into
 * the Supervisor/brain (status mapping, budget, escalation, webhooks) is a
 * separate step — see the notes at the bottom of the file.
 */

/** A pending permission the agent is asking the operator to grant. */
export interface OpenCodePermission {
  /** Permission id — echoed back to the response route. */
  id: string;
  sessionID: string;
  /** Kind of action, e.g. "bash", "edit", "webfetch". */
  type?: string;
  /** Human-readable summary of what it wants to do. */
  title?: string;
  /** Tool-specific details (command, file path, …). */
  metadata?: unknown;
}

/** How to answer a permission: allow once, allow always (remember), or reject. */
export type OpenCodePermissionResponse = "once" | "always" | "reject";

export interface OpenCodeSessionOptions {
  /** Base URL of a running `opencode serve`, e.g. http://127.0.0.1:4919. */
  baseUrl: string;
  /** Provider id as OpenCode exposes it (e.g. "lmstudio", "groq", "opencode"). */
  providerID: string;
  /** Model id within that provider (e.g. "qwen/qwen3-coder-30b"). */
  modelID: string;
  /** Agent to drive (default "build"). */
  agent?: string;
  /** Optional human title for the created session. */
  title?: string;
  /**
   * Decide how to answer a permission request. Default: reject — safe under
   * unattended automation, mirroring ClaudeSession's default-deny on dangerous
   * gates. The Supervisor wiring will replace this with the guard/brain policy.
   */
  onPermission?: (
    p: OpenCodePermission,
  ) => Promise<OpenCodePermissionResponse> | OpenCodePermissionResponse;
  /** Hard cap for a single turn (ms). Default 15 min. */
  turnTimeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Result of one driven turn — deliberately shaped like ClaudeSession's TurnResult. */
export interface OpenCodeTurnResult {
  prompt: string;
  /** Concatenated assistant text parts for this turn. */
  assistantText: string;
  /** All parts the assistant produced (text + tool calls), for richer callers. */
  parts: Array<{ type: string; text?: string; tool?: string }>;
  /** Permission requests answered during this turn. */
  permissionsHandled: number;
  durationMs: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Pull the permission object out of a `permission.*` event's properties. */
function permissionFromEvent(props: unknown): OpenCodePermission | null {
  if (!isRecord(props)) return null;
  // Shapes seen/expected: { properties:{id,sessionID,…} } already unwrapped to props,
  // or nested under props.permission. Tolerate both.
  const p = isRecord(props.permission) ? props.permission : props;
  const id = p.id ?? p.permissionID;
  const sessionID = p.sessionID;
  if (typeof id !== "string" || typeof sessionID !== "string") return null;
  return {
    id,
    sessionID,
    type: typeof p.type === "string" ? p.type : undefined,
    title: typeof p.title === "string" ? p.title : undefined,
    metadata: p.metadata,
  };
}

export class OpenCodeSession {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly agent: string;
  private readonly turnTimeoutMs: number;
  /** OpenCode session id, set by start(). */
  sessionId = "";

  private eventAbort?: AbortController;
  private eventLoop?: Promise<void>;
  private closed = false;
  private permissionsThisTurn = 0;
  /** Permission ids already answered, so a repeated event isn't answered twice. */
  private answered = new Set<string>();

  constructor(private readonly opts: OpenCodeSessionOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.agent = opts.agent ?? "build";
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 15 * 60_000;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** Create the session and start the concurrent event/permission reader. */
  async start(): Promise<void> {
    const res = await this.fetchImpl(this.url("/session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: this.opts.title ?? "agi-orchestrator session" }),
    });
    if (!res.ok) throw new Error(`opencode: create session failed (${res.status})`);
    const session = (await res.json()) as { id?: string };
    if (!session.id) throw new Error("opencode: create session returned no id");
    this.sessionId = session.id;

    // Open the persistent event stream that answers permission requests while a
    // turn POST is blocked. Kick it off; don't await (it runs until dispose()).
    this.eventAbort = new AbortController();
    this.eventLoop = this.readEvents(this.eventAbort.signal).catch(() => {
      /* stream ended / aborted — normal on dispose */
    });
  }

  /**
   * Read the SSE `/event` stream line-by-line and answer permission requests for
   * OUR session. Runs for the lifetime of the session.
   */
  private async readEvents(signal: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(this.url("/event"), {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (!this.closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; each has one or more `data:` lines.
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split(/\r?\n/)) {
          const m = /^data:\s?(.*)$/.exec(line);
          if (!m || m[1] === undefined) continue;
          let evt: { type?: string; properties?: unknown };
          try {
            evt = JSON.parse(m[1]);
          } catch {
            continue;
          }
          if (typeof evt.type === "string" && evt.type.startsWith("permission")) {
            await this.handlePermission(evt.properties);
          }
        }
      }
    }
  }

  /** Answer one permission request via the configured policy (default: reject). */
  private async handlePermission(props: unknown): Promise<void> {
    const perm = permissionFromEvent(props);
    if (!perm || perm.sessionID !== this.sessionId) return;
    if (this.answered.has(perm.id)) return;
    this.answered.add(perm.id);

    let response: OpenCodePermissionResponse = "reject";
    try {
      response = (await (this.opts.onPermission?.(perm) ?? "reject")) as OpenCodePermissionResponse;
    } catch {
      response = "reject";
    }

    try {
      await this.fetchImpl(this.url(`/session/${this.sessionId}/permission/${perm.id}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response }),
      });
      this.permissionsThisTurn++;
    } catch {
      /* server gone / turn already resolved — nothing to do */
    }
  }

  /**
   * Inject a prompt and drive the turn to completion. The POST blocks until the
   * turn is idle; permission requests raised meanwhile are answered by the event
   * loop started in start(). Returns the assistant's reply for this turn.
   */
  async runTurn(prompt: string): Promise<OpenCodeTurnResult> {
    if (!this.sessionId) throw new Error("opencode session not started");
    const startedAt = Date.now();
    this.permissionsThisTurn = 0;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.turnTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(`/session/${this.sessionId}/message`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: { providerID: this.opts.providerID, modelID: this.opts.modelID },
          agent: this.agent,
          parts: [{ type: "text", text: prompt }],
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`opencode: prompt failed (${res.status})`);

    const body = (await res.json()) as { info?: unknown; parts?: unknown };
    const rawParts = Array.isArray(body.parts) ? body.parts : [];
    const parts = rawParts
      .filter(isRecord)
      .map((p) => ({
        type: typeof p.type === "string" ? p.type : "unknown",
        text: typeof p.text === "string" ? p.text : undefined,
        tool: typeof p.tool === "string" ? p.tool : undefined,
      }));
    const assistantText = parts
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();

    return {
      prompt,
      assistantText,
      parts,
      permissionsHandled: this.permissionsThisTurn,
      durationMs: Date.now() - startedAt,
    };
  }

  /** Cancel any in-flight turn and tear down the event stream. */
  async dispose(): Promise<void> {
    this.closed = true;
    if (this.sessionId) {
      try {
        await this.fetchImpl(this.url(`/session/${this.sessionId}/abort`), { method: "POST" });
      } catch {
        /* best effort */
      }
    }
    this.eventAbort?.abort();
    try {
      await this.eventLoop;
    } catch {
      /* aborted */
    }
  }
}

/*
 * Supervisor wiring — NOT done in this prototype (intentional next step):
 *  - lifecycle: manage `opencode serve` (spawn one headless server, or `attach` to
 *    a user-run one) and pool sessions against it.
 *  - status mapping: session.status busy/idle → SessionStatus running/idle; a
 *    blocked permission → "needs-input"; session.error → "error".
 *  - permission policy: replace the default-reject `onPermission` with the existing
 *    gate guard (classifyGate/brain autonomy) so risky actions escalate to the human.
 *  - budget/usage: OpenCode has no Claude /usage panel; cost comes from its own
 *    provider. With a LOCAL provider (lmstudio) it's subscription-safe like the
 *    Claude PTY path; with a paid provider it is NOT — the Supervisor must gate that.
 *  - transcript: reuse readOpenCodeMessages()/discovery so a driven OpenCode session
 *    is minable and resumable exactly like a Claude one.
 */
