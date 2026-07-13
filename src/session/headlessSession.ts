/**
 * HeadlessClaudeSession — drives Claude Code in PRINT MODE (`claude -p`) instead
 * of scraping the interactive TUI. One short-lived process per turn:
 *
 *   turn 1:   claude -p --session-id <uuid> --output-format stream-json --verbose
 *   turn 2+:  claude -p --resume <uuid>     --output-format stream-json --verbose
 *
 * The prompt goes in on stdin; stdout is newline-delimited JSON with structured
 * turn boundaries (a final {"type":"result", ...} line) — no screen, no regexes,
 * no gates, none of the TUI-drift failure class. Subscription-safety is unchanged:
 * this is the same claude.exe binary using the same cached login (scrubbedEnv
 * strips any API-key/billing env), no Agent SDK, no API key.
 *
 * Print-mode trade-offs (decision D9): no interactive gate mediation (permission
 * behavior comes from --permission-mode + settings allow-lists; denied tools are
 * denied, claude routes around them), no live TUI to watch, and /usage / /context
 * panels aren't readable (usage + context guards are inert for these sessions).
 * Structurally satisfies the orchestrator's AgentSession interface.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { transcriptResumable } from "../transcript/reader.js";
import { CwdError, TimeoutError } from "./claudeSession.js";
import type { ScreenTriage } from "./claudeSession.js";
import type { UsageStatus } from "../policy/usage.js";
import { scrubbedEnv } from "../util/env.js";
import type { GateRequest, GateResolution, ScreenState, SessionConfig, TurnResult } from "../types.js";

const TURN_TIMEOUT_MS = 90 * 60_000; // same per-turn hard cap as the PTY engine

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Kill a child process AND its descendants. `claude -p` spawns its own children
 * (shells, MCP servers); on Windows plain ChildProcess.kill() terminates only the
 * direct child and leaks the tree — use taskkill /T. Best-effort.
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  try {
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      child.kill();
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Extract concatenated text blocks from a stream-json assistant message. */
export function textFromAssistant(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === "object")
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

/**
 * Incremental parser for `claude -p --output-format stream-json` stdout.
 * Feed raw chunks; it tracks the last assistant text, the final result line
 * (text / error flag / authoritative session id), and tolerates non-JSON noise.
 * Pure and exported so it unit-tests offline against captured fixtures.
 */
export class StreamJsonParser {
  private buf = "";
  lastAssistantText = "";
  resultText: string | undefined;
  resultIsError = false;
  sawResult = false;
  resultSessionId: string | undefined;

  feed(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl === -1) break;
      this.line(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  /** Consume any final unterminated line (call once, at stream end). */
  flush(): void {
    if (this.buf.trim()) this.line(this.buf);
    this.buf = "";
  }

  /** The turn's reply: the result line's text, else the last assistant message. */
  get assistantText(): string {
    return this.resultText ?? this.lastAssistantText;
  }

  private line(raw: string): void {
    const t = raw.trim();
    if (!t) return;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(t);
    } catch {
      return; // non-JSON noise (defensive)
    }
    if (entry.type === "assistant") {
      const text = textFromAssistant(entry.message);
      if (text) this.lastAssistantText = text;
    } else if (entry.type === "result") {
      this.sawResult = true;
      if (typeof entry.session_id === "string" && UUID_RE.test(entry.session_id)) {
        this.resultSessionId = entry.session_id;
      }
      this.resultIsError =
        entry.is_error === true || (typeof entry.subtype === "string" && entry.subtype !== "success");
      if (typeof entry.result === "string" && entry.result.trim()) this.resultText = entry.result.trim();
    }
  }
}

export class HeadlessClaudeSession {
  private id: string;
  private disposed = false;
  private child: ChildProcessWithoutNullStreams | undefined;
  private turnActive = false;
  /** Use --resume (a conversation exists) instead of --session-id (mint one). */
  private hasConversation: boolean;
  /** Rolling tail of assistant output — the dashboard's "screen". */
  private tail = "(headless session — no TUI; output appears per turn)";

  /** Print mode can't drive the /context + /compact panel flow — the guard skips it. */
  readonly supportsCompaction = false;

  /** Present for AgentSession compatibility; print mode never raises TUI gates. */
  onGate?: (req: GateRequest) => Promise<GateResolution>;
  onTriage?: (screenText: string) => Promise<ScreenTriage | null>;

  constructor(private readonly cfg: SessionConfig) {
    if (cfg.resumeId && UUID_RE.test(cfg.resumeId)) {
      this.id = cfg.resumeId;
      // Ground truth, not assumption: a recovery respawn passes resumeId even
      // when the first turn crashed before any conversation reached disk —
      // `--resume` on a non-existent OR message-less conversation exits 1.
      // Resume only when the transcript holds at least one real message;
      // otherwise mint the SAME id via --session-id.
      this.hasConversation = transcriptResumable(cfg.cwd, this.id);
    } else {
      this.id = UUID_RE.test(cfg.id) ? cfg.id : randomUUID();
      this.hasConversation = false;
    }
  }

  get sessionId(): string {
    return this.id;
  }

  /** No process to boot — just make sure the workspace exists (mirrors the PTY engine). */
  async start(): Promise<void> {
    const cwd = this.cfg.cwd;
    if (existsSync(cwd)) {
      if (!statSync(cwd).isDirectory()) throw new CwdError(`project path is not a directory: "${cwd}"`);
      return;
    }
    try {
      mkdirSync(cwd, { recursive: true });
    } catch (e) {
      throw new CwdError(`project directory does not exist and could not be created: "${cwd}" (${(e as Error).message})`);
    }
  }

  /** Run one turn: spawn `claude -p`, feed the prompt on stdin, await the result line. */
  async runTurn(prompt: string): Promise<TurnResult> {
    if (this.disposed) throw new Error("session not running");
    const startedAt = Date.now();
    const idArgs = this.hasConversation ? ["--resume", this.id] : ["--session-id", this.id];
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      ...idArgs,
      "--permission-mode",
      this.cfg.permissionMode ?? "acceptEdits",
    ];

    return new Promise<TurnResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn("claude.exe", args, {
          cwd: this.cfg.cwd,
          env: scrubbedEnv(),
          windowsHide: true,
        });
      } catch (e) {
        reject(new Error(`could not start claude -p in "${this.cfg.cwd}": ${(e as Error).message}`));
        return;
      }
      this.child = child;
      this.turnActive = true;

      const parser = new StreamJsonParser();
      let lastSeenAssistant = "";
      let stderrTail = "";
      let settled = false;

      const timer = setTimeout(() => {
        finish(new TimeoutError(`claude -p turn exceeded ${TURN_TIMEOUT_MS / 60_000} minutes — killed`));
        killTree(child);
      }, TURN_TIMEOUT_MS);

      const finish = (err: Error | null, result?: TurnResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.turnActive = false;
        this.child = undefined;
        if (err) reject(err);
        else resolve(result!);
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        parser.feed(d);
        if (parser.lastAssistantText && parser.lastAssistantText !== lastSeenAssistant) {
          lastSeenAssistant = parser.lastAssistantText;
          this.tail = parser.lastAssistantText.slice(-4000);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => {
        stderrTail = (stderrTail + d).slice(-1000);
      });
      child.on("error", (e) => finish(new Error(`claude -p failed to spawn: ${e.message}`)));
      child.on("close", (code) => {
        parser.flush();
        if (parser.sawResult) {
          this.hasConversation = true;
          if (parser.resultSessionId) this.id = parser.resultSessionId; // authoritative — future turns resume THIS conversation
        }
        const assistantText = parser.assistantText;
        if (code !== 0 || parser.resultIsError) {
          finish(
            new Error(
              `claude exited (code ${code ?? "?"}) in print mode` +
                `${parser.resultIsError ? " (result reported an error)" : ""}. ` +
                `Output tail: ${(assistantText || stderrTail || "(none)").slice(-300)}`,
            ),
          );
          return;
        }
        finish(null, {
          prompt,
          assistantText,
          gatesHandled: 0,
          durationMs: Date.now() - startedAt,
        });
      });

      child.stdin.on("error", () => {
        /* EPIPE if claude died instantly — the close handler reports it */
      });
      child.stdin.write(prompt.replace(/\r\n?/g, "\n"));
      child.stdin.end();
    });
  }

  /** Print mode can't read the /usage panel — the usage guard is inert here. */
  async readUsage(): Promise<UsageStatus | undefined> {
    return undefined;
  }

  /** Print mode can't read the /context panel — callers fall back to estimates. */
  async readContextFraction(): Promise<number | null> {
    return null;
  }

  screenText(): string {
    return this.tail;
  }

  state(): ScreenState {
    return this.turnActive ? "working" : "ready";
  }

  get isAlive(): boolean {
    return !this.disposed;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.child) {
      killTree(this.child);
      this.child = undefined;
    }
    this.turnActive = false;
  }
}
