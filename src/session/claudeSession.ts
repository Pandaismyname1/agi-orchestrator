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
import { existsSync, mkdirSync, statSync } from "node:fs";
import * as pty from "node-pty";
import { VirtualScreen } from "../terminal/screen.js";
import { classifyScreen, detectAuthError, detectRateLimit } from "../terminal/state.js";
import { classifyGate } from "../terminal/gates.js";
import { readLastAssistantMessage } from "../transcript/reader.js";
import { parseUsage, type UsageStatus } from "../policy/usage.js";
import { scrubbedEnv } from "../util/env.js";
import type { GateRequest, GateResolution, ScreenState, SessionConfig, TurnResult } from "../types.js";

const ESC = "\x1b"; // cancels/denies a claude TUI gate ("Esc to cancel")

const COLS = 120;
const ROWS = 40;
const POLL_MS = 500;
const READY_SETTLE_MS = 2500; // ready must hold this long to count as turn-end
const BOOT_TIMEOUT_MS = 45_000;
// Resuming a session replays its (possibly huge) transcript and may auto-continue
// an in-flight turn, so a fixed short boot deadline wrongly kills a healthy resume.
// Instead: stay patient up to a generous cap while the screen is still CHANGING
// (replay/work), and only fail fast if it's been frozen (stuck) and never ready.
const RESUME_BOOT_CAP_MS = 10 * 60_000;
const RESUME_STUCK_MS = 45_000;
// A turn isn't done until the main prompt is idle AND any background agents it
// spawned have finished — which can legitimately take a long time. So the per-turn
// wait is progress-aware: patient up to a generous hard cap while the screen keeps
// changing (spinner / agent token counters), failing fast only if it's frozen.
const TURN_TIMEOUT_MS = 90 * 60_000; // hard cap per single turn
const TURN_STUCK_MS = 8 * 60_000; // …unless the screen is frozen this long
const GATE_COOLDOWN_MS = 900;
const MIN_THINK_MS = 1500; // ignore "ready" for this long after injecting (avoid premature turn-end)

export class AuthError extends Error {}
export class TimeoutError extends Error {}
export class RateLimitError extends Error {}
/** The session's working directory is missing or unusable. */
export class CwdError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ClaudeSession {
  readonly sessionId: string;
  private readonly screen = new VirtualScreen(COLS, ROWS);
  private term: pty.IPty | undefined;
  private exited = false;
  private exitCode: number | null = null;

  /**
   * Optional handler for a DANGEROUS gate. Returns approve/deny. If unset, the
   * session default-denies dangerous gates (safe under unattended automation).
   */
  onGate?: (req: GateRequest) => Promise<GateResolution>;

  constructor(private readonly cfg: SessionConfig) {
    // claude --session-id and the transcript path require a real UUID. The
    // config `id` is just a friendly display label, so only reuse it when it
    // already is a UUID; otherwise mint one. When resuming, the transcript id IS
    // the resumed session's id.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (cfg.resumeId && UUID_RE.test(cfg.resumeId)) this.sessionId = cfg.resumeId;
    else this.sessionId = UUID_RE.test(cfg.id) ? cfg.id : randomUUID();
  }

  /** Spawn claude and wait until it's booted and idle (boot gates auto-cleared). */
  async start(): Promise<void> {
    this.ensureCwd();

    // Resume an existing session, or start a fresh one with a forced id.
    const idArgs = this.cfg.resumeId
      ? ["--resume", this.sessionId]
      : ["--session-id", this.sessionId];
    const args = [...idArgs, "--permission-mode", this.cfg.permissionMode ?? "acceptEdits"];
    try {
      this.term = pty.spawn("claude.exe", args, {
        name: "xterm-256color",
        cols: COLS,
        rows: ROWS,
        cwd: this.cfg.cwd,
        env: scrubbedEnv(),
        useConptyDll: true,
      });
    } catch (e) {
      // ConPTY surfaces a missing/invalid cwd as a cryptic
      // "Cannot create process, error code: 267" (ERROR_DIRECTORY). Make it clear.
      throw new CwdError(`could not start claude in "${this.cfg.cwd}": ${(e as Error).message}`);
    }
    this.term.onData((d) => this.screen.write(d));
    this.term.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode ?? 0;
    });

    // Fresh boot is quick (45s). A resume can legitimately take much longer (it
    // replays the transcript and may auto-continue), so give it a generous cap but
    // bail fast if the screen freezes (a stuck picker / unrecognized prompt).
    if (this.cfg.resumeId) {
      await this.waitForReady(RESUME_BOOT_CAP_MS, /*requireThink*/ false, RESUME_STUCK_MS);
    } else {
      await this.waitForReady(BOOT_TIMEOUT_MS, /*requireThink*/ false);
    }
  }

  /**
   * The working directory must exist before ConPTY can spawn into it. For this
   * tool the cwd is the deliberate workspace you point an agent at, so create it
   * if it's missing rather than failing with a cryptic OS error. A path that
   * exists but isn't a directory (or can't be created) is a hard, clear error.
   */
  private ensureCwd(): void {
    const cwd = this.cfg.cwd;
    if (existsSync(cwd)) {
      if (!statSync(cwd).isDirectory()) {
        throw new CwdError(`project path is not a directory: "${cwd}"`);
      }
      return;
    }
    try {
      mkdirSync(cwd, { recursive: true });
      console.log(`[session ${this.cfg.id}] created missing cwd: ${cwd}`);
    } catch (e) {
      throw new CwdError(`project directory does not exist and could not be created: "${cwd}" (${(e as Error).message})`);
    }
  }

  /** Inject a prompt and drive the turn to completion; return claude's reply text. */
  async runTurn(prompt: string): Promise<TurnResult> {
    if (!this.term || this.exited) throw new Error("session not running");
    const startedAt = Date.now();

    this.type(prompt);
    await sleep(300);
    this.type("\r"); // submit

    const gatesHandled = await this.waitForReady(TURN_TIMEOUT_MS, /*requireThink*/ true, TURN_STUCK_MS);

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
  /**
   * Wait until the TUI settles to "ready" (idle input box).
   *  - timeoutMs: hard cap.
   *  - requireThink: don't accept "ready" until claude has actually started working
   *    (used per-turn so we don't latch the pre-existing idle box).
   *  - stuckMs: if set, fail as soon as the SCREEN has been unchanged this long
   *    without becoming ready. This lets a slow-but-progressing resume (transcript
   *    replay / auto-continue keeps the screen moving) run up to the hard cap, while
   *    a genuinely frozen screen (stuck picker / unrecognized prompt) still fails fast.
   */
  private async waitForReady(timeoutMs: number, requireThink: boolean, stuckMs?: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    const injectedAt = Date.now();
    let readySince: number | null = null;
    let sawNonReady = false;
    let gates = 0;
    let lastText = "";
    let lastChangeAt = Date.now();
    let lastState: ScreenState = "unknown";

    const fail = (why: string): never => {
      throw new TimeoutError(
        `${why} (last state: ${lastState}). Screen tail: ${this.screenTail(lastText)}`,
      );
    };

    while (true) {
      if (this.exited) {
        throw new Error(`claude exited (code ${this.exitCode}) while waiting for ready`);
      }
      if (Date.now() > deadline) {
        fail(`timed out after ${(timeoutMs / 1000).toFixed(0)}s waiting for ready`);
      }

      const text = this.screen.visibleText();
      // Treat any change in the rendered screen as progress (replay scrolling, a
      // working spinner, streaming output). A static screen means claude is stuck.
      if (text !== lastText) {
        lastText = text;
        lastChangeAt = Date.now();
      }
      if (stuckMs !== undefined && Date.now() - lastChangeAt > stuckMs) {
        fail(`claude's screen was frozen for ${(stuckMs / 1000).toFixed(0)}s and never became ready`);
      }
      if (detectAuthError(text)) {
        throw new AuthError("claude reported an authentication error (401). Run `claude` and `/login`.");
      }
      if (detectRateLimit(text)) {
        throw new RateLimitError("claude hit the subscription usage limit — pausing this session.");
      }

      const state: ScreenState = classifyScreen(text);
      lastState = state;

      if (state === "gate") {
        await this.handleGate(text);
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

  /**
   * Handle one gate. Safe gates (and everything under gatePolicy "auto") are
   * auto-approved with Enter. Dangerous gates under "guard" are escalated via
   * onGate; approve → Enter, deny → Esc (claude treats Esc as "cancel/no"). With
   * no handler, dangerous gates default-deny.
   */
  private async handleGate(text: string): Promise<void> {
    const policy = this.cfg.gatePolicy ?? "guard";
    const cls = classifyGate(text);

    if (policy === "auto" || cls.danger === "safe") {
      this.type("\r"); // approve the highlighted default
      return;
    }

    // Dangerous gate under "guard".
    const resolution: GateResolution = this.onGate
      ? await this.onGate({ id: randomUUID(), sessionId: this.sessionId, summary: cls.summary })
      : { kind: "deny" };

    this.type(resolution.kind === "approve" ? "\r" : ESC);
  }

  private type(s: string): void {
    this.term?.write(s);
  }

  /** Last few non-blank screen lines, trimmed — for diagnosing a stuck boot/turn. */
  private screenTail(text: string, lines = 6, width = 100): string {
    const tail = text
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.length > 0)
      .slice(-lines)
      .map((l) => (l.length > width ? l.slice(0, width) + "…" : l))
      .join(" ⏎ ");
    return tail || "(blank screen)";
  }

  /**
   * Read Claude's own `/usage` panel — the REAL subscription limits (session /
   * weekly all-models / weekly Sonnet). Drive ONLY when the session is idle
   * (ready); `/usage` is a local command that burns no model usage. Opens the
   * panel, snapshots it, and closes it with Esc. Returns undefined if nothing
   * parseable rendered (so the caller keeps its last known status).
   */
  async readUsage(): Promise<UsageStatus | undefined> {
    if (!this.term || this.exited) return undefined;
    this.type("/usage");
    await sleep(700);
    this.type("\r");
    await sleep(3500); // the /usage panel is long and renders progressively
    // The panel is taller than the 40-row viewport, so the "Current session/week"
    // limit bars scroll above it — read the scrollback buffer, not just the viewport.
    const text = this.screen.fullText(120);
    this.type(ESC); // close the panel
    await sleep(400);
    const status = parseUsage(text);
    if (!status.session && !status.weeklyAll && !status.weeklySonnet) return undefined;
    return status;
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
