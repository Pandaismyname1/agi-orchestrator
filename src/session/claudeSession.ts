/**
 * ClaudeSession — owns ONE interactive `claude.exe` process inside a PTY and
 * drives it turn by turn. This is the subscription-safe injection mechanism:
 * it's the genuine interactive CLI (logged into the user's subscription), and
 * we read/write it through the pseudo-terminal we own.
 *
 * Reading strategy (decided during de-risking):
 *   - the TUI SCREEN (via VirtualScreen emulator) tells us STATE: working / ready / gate
 *   - the assistant's MESSAGE TEXT is read from the transcript JSONL (clean, stable)
 */
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { VirtualScreen } from "../terminal/screen.js";
import { classifyScreen, detectAuthError, defaultGateChoice } from "../terminal/state.js";
import { readLastAssistantMessage } from "../transcript/reader.js";
import { scrubbedEnv } from "../util/env.js";
import type { ScreenState, SessionConfig, TurnResult } from "../types.js";

const COLS = 120;
const ROWS = 40;
const POLL_MS = 500;
const READY_SETTLE_MS = 2500; // ready must hold this long to count as turn-end
const BOOT_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 15 * 60_000; // safety cap per single turn
const GATE_COOLDOWN_MS = 900;
const MIN_THINK_MS = 1500; // ignore "ready" for this long after injecting (avoid premature turn-end)

export class AuthError extends Error {}
export class TimeoutError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ClaudeSession {
  readonly sessionId: string;
  private readonly screen = new VirtualScreen(COLS, ROWS);
  private term: pty.IPty | undefined;
  private exited = false;
  private exitCode: number | null = null;

  constructor(private readonly cfg: SessionConfig) {
    // claude --session-id and the transcript path require a real UUID. The
    // config `id` is just a friendly display label, so only reuse it when it
    // already is a UUID; otherwise mint one.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    this.sessionId = UUID_RE.test(cfg.id) ? cfg.id : randomUUID();
  }

  /** Spawn claude and wait until it's booted and idle (boot gates auto-cleared). */
  async start(): Promise<void> {
    const args = [
      "--session-id",
      this.sessionId,
      "--permission-mode",
      this.cfg.permissionMode ?? "acceptEdits",
    ];
    this.term = pty.spawn("claude.exe", args, {
      name: "xterm-256color",
      cols: COLS,
      rows: ROWS,
      cwd: this.cfg.cwd,
      env: scrubbedEnv(),
      useConptyDll: true,
    });
    this.term.onData((d) => this.screen.write(d));
    this.term.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode ?? 0;
    });

    await this.waitForReady(BOOT_TIMEOUT_MS, /*requireThink*/ false);
  }

  /** Inject a prompt and drive the turn to completion; return claude's reply text. */
  async runTurn(prompt: string): Promise<TurnResult> {
    if (!this.term || this.exited) throw new Error("session not running");
    const startedAt = Date.now();

    this.type(prompt);
    await sleep(300);
    this.type("\r"); // submit

    const gatesHandled = await this.waitForReady(TURN_TIMEOUT_MS, /*requireThink*/ true);

    const assistantText = await readLastAssistantMessage(this.cfg.cwd, this.sessionId);
    return {
      prompt,
      assistantText,
      gatesHandled,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Poll the screen until claude is idle/ready and has held ready for the settle
   * window. Auto-clears gates along the way. Returns number of gates handled.
   * Throws AuthError on 401 and TimeoutError past the deadline.
   */
  private async waitForReady(timeoutMs: number, requireThink: boolean): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    const injectedAt = Date.now();
    let readySince: number | null = null;
    let sawNonReady = false;
    let gates = 0;

    while (true) {
      if (this.exited) {
        throw new Error(`claude exited (code ${this.exitCode}) while waiting for ready`);
      }
      if (Date.now() > deadline) {
        throw new TimeoutError(`timed out after ${(timeoutMs / 1000).toFixed(0)}s waiting for ready`);
      }

      const text = this.screen.visibleText();
      if (detectAuthError(text)) {
        throw new AuthError("claude reported an authentication error (401). Run `claude` and `/login`.");
      }

      const state: ScreenState = classifyScreen(text);

      if (state === "gate") {
        const choice = defaultGateChoice(text);
        // Move highlight to the default choice is unnecessary — it's already the
        // highlighted one — so just confirm with Enter.
        void choice;
        this.type("\r");
        gates += 1;
        sawNonReady = true;
        readySince = null;
        await sleep(GATE_COOLDOWN_MS);
        continue;
      }

      if (state === "working" || state === "unknown") {
        sawNonReady = true;
        readySince = null;
      } else if (state === "ready") {
        // Don't accept "ready" as turn-end until claude has actually started
        // working (or enough time passed) — avoids latching the idle box that
        // was on screen the instant before our prompt registered.
        const thinkOk = !requireThink || sawNonReady || Date.now() - injectedAt > MIN_THINK_MS;
        if (thinkOk) {
          if (readySince === null) readySince = Date.now();
          if (Date.now() - readySince >= READY_SETTLE_MS) return gates;
        }
      }

      await sleep(POLL_MS);
    }
  }

  private type(s: string): void {
    this.term?.write(s);
  }

  /** Current clean screen text (for the dashboard). */
  screenText(): string {
    return this.screen.visibleText();
  }

  state(): ScreenState {
    return classifyScreen(this.screen.visibleText());
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  /**
   * Graceful teardown. Kills the pty and WAITS for it to actually exit before
   * disposing the emulator — otherwise node-pty's Windows ConPTY socket worker
   * can still be mid-close and trips a libuv assertion (UV_HANDLE_CLOSING).
   */
  async dispose(): Promise<void> {
    if (this.term && !this.exited) {
      try {
        this.term.kill();
      } catch {
        /* already gone */
      }
    }
    const deadline = Date.now() + 1500;
    while (!this.exited && Date.now() < deadline) await sleep(50);
    await sleep(150);
    try {
      this.screen.dispose();
    } catch {
      /* noop */
    }
  }
}
