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
import { execFile } from "node:child_process";
import * as pty from "node-pty";
import { VirtualScreen } from "../terminal/screen.js";
import {
  classifyScreen,
  detectAuthError,
  detectRateLimit,
  detectFeedbackSurvey,
  detectChoicePrompt,
} from "../terminal/state.js";
import { parseContextFraction } from "../policy/context.js";
import { classifyGate } from "../terminal/gates.js";
import {
  readLastAssistantMessage,
  transcriptStat,
  transcriptTurnEnded,
} from "../transcript/reader.js";
import { parseUsage, type UsageStatus } from "../policy/usage.js";
import { scrubbedEnv } from "../util/env.js";
import type { GateRequest, GateResolution, ScreenState, SessionConfig, TurnResult } from "../types.js";

const ESC = "\x1b"; // cancels/denies a claude TUI gate ("Esc to cancel")
// Bracketed-paste envelope: the TUI treats the payload as ONE paste (newlines
// included, nothing auto-submits), so a multi-line brain prompt can't half-submit
// and the rapid-typing paste heuristic can't swallow the trailing Enter.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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
// An AskUserQuestion menu is Esc-dismissed so the turn can end; if Claude keeps
// reopening one within a single turn, bail with a clear error instead of spinning
// (or silently re-dismissing) until the multi-minute turn timeout.
const MAX_CHOICE_DISMISSALS = 6;
// Submission verification: after Enter, evidence that the turn started must appear
// within this window, else the Enter was swallowed and is re-sent (bounded).
const SUBMIT_VERIFY_MS = 4000;
const SUBMIT_RETRIES = 3;
// The feedback survey wants "0: Dismiss" on current builds; older builds took Esc.
// Attempts alternate 0/Esc; past the cap the survey is treated as a stuck screen.
const MAX_SURVEY_DISMISSALS = 8;
// Recovery ladder tuning: transcript growth within this window counts as live
// progress even when the rendered screen looks frozen (the transcript is appended
// continuously while claude works — it's the ground truth; the screen is not).
const TRANSCRIPT_ACTIVE_MS = 45_000;
// At most this many Qwen screen-triage keypress attempts per wait.
const MAX_TRIAGES = 3;

/**
 * A fallback classification of an unrecognized/frozen screen, produced by the
 * local brain (Qwen). `key` is the single keystroke it suggests — the session
 * only ever acts on Enter, Esc, or one digit (never free text; see decision D7).
 */
export interface ScreenTriage {
  state: "ready" | "working" | "gate" | "menu" | "survey" | "error" | "unknown";
  key?: string;
  reason?: string;
}

/** Map a triage key suggestion to the byte(s) to type; null = not allowed. */
export function triageKeyBytes(key: string | undefined): string | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  if (k === "enter" || k === "return" || k === "\r") return "\r";
  if (k === "esc" || k === "escape") return ESC;
  if (/^[0-9]$/.test(k)) return k;
  return null;
}

/** `claude --version`, resolved once per process — for exit/boot diagnostics. */
let cachedClaudeVersion: string | undefined;
export function claudeVersion(): Promise<string> {
  if (cachedClaudeVersion !== undefined) return Promise.resolve(cachedClaudeVersion);
  return new Promise((resolve) => {
    execFile("claude.exe", ["--version"], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      cachedClaudeVersion = err ? "(unknown)" : stdout.trim();
      resolve(cachedClaudeVersion);
    });
  });
}

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
  /** Last screen tail captured the moment claude exited — the crash diagnostic. */
  private exitTail = "";

  /**
   * Optional handler for a DANGEROUS gate. Returns approve/deny. If unset, the
   * session default-denies dangerous gates (safe under unattended automation).
   */
  onGate?: (req: GateRequest) => Promise<GateResolution>;

  /**
   * Optional fallback screen classifier (the local brain). Consulted by the
   * recovery ladder when the screen is frozen and unrecognized, BEFORE giving up.
   * May suggest one safe keystroke (Enter/Esc/digit); anything else is ignored.
   */
  onTriage?: (screenText: string) => Promise<ScreenTriage | null>;

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
      // Snapshot the final screen NOW — it's the only evidence of why claude died
      // (auth failure, bad --resume id, crash banner). Read before dispose clears it.
      try {
        this.exitTail = this.screenTail(this.screen.visibleText(), 12);
      } catch {
        /* emulator already disposed */
      }
    });
    void claudeVersion().then((v) => console.log(`[session ${this.cfg.id}] claude ${v}`));

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

    // Dismiss Claude's "How is Claude doing?" survey if it's up — otherwise it can
    // swallow the first keystroke of our prompt as a 1/2/3 rating.
    for (let i = 0; i < 3 && detectFeedbackSurvey(this.screen.visibleText()); i++) {
      this.type(this.surveyKey(i));
      await sleep(500);
    }

    // Transcript byte offset before injection — the ground-truth marker for "did
    // this turn produce a reply", used by the frozen-screen recovery ladder.
    const sinceOffset = (await transcriptStat(this.cfg.cwd, this.sessionId))?.size ?? 0;

    await this.inject(prompt);

    const gatesHandled = await this.waitForReady(
      TURN_TIMEOUT_MS,
      /*requireThink*/ true,
      TURN_STUCK_MS,
      sinceOffset,
    );

    const assistantText = await readLastAssistantMessage(this.cfg.cwd, this.sessionId);
    return {
      prompt,
      assistantText,
      gatesHandled,
      durationMs: Date.now() - startedAt,
    };
  }

  /** The survey key for the Nth dismissal attempt: "0: Dismiss" first, Esc fallback. */
  private surveyKey(attempt: number): string {
    return attempt % 2 === 0 ? "0" : ESC;
  }

  /**
   * Type the prompt (as one bracketed paste, so embedded newlines can't half-submit)
   * and press Enter — then VERIFY the turn actually started. The TUI occasionally
   * swallows the Enter (mid-render race); un-verified injection left "> continue"
   * sitting in the input box until the stuck-timeout killed the run. Evidence of a
   * started turn: the screen leaves the idle/static state (working spinner, a gate,
   * a choice menu) or keeps changing. A still-frozen screen gets Enter re-sent, a
   * bounded number of times; after that waitForReady's recovery ladder takes over.
   */
  private async inject(prompt: string): Promise<void> {
    const normalized = prompt.replace(/\r\n?/g, "\n");
    this.type(PASTE_START + normalized + PASTE_END);
    await sleep(400); // let the paste render before submitting
    for (let attempt = 0; attempt < SUBMIT_RETRIES; attempt++) {
      this.type("\r");
      const baseline = this.screen.visibleText();
      const deadline = Date.now() + SUBMIT_VERIFY_MS;
      while (Date.now() < deadline) {
        await sleep(250);
        if (this.exited) return; // waitForReady will surface the exit diagnostics
        const text = this.screen.visibleText();
        const state = classifyScreen(text);
        // Any post-Enter screen activity or in-flight/gate state = the submit took.
        if (state === "working" || state === "gate" || detectChoicePrompt(text) || text !== baseline) {
          return;
        }
      }
      // Screen completely static since Enter — assume it was swallowed; re-send.
    }
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
  private async waitForReady(
    timeoutMs: number,
    requireThink: boolean,
    stuckMs?: number,
    sinceOffset?: number,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    const injectedAt = Date.now();
    let readySince: number | null = null;
    let sawNonReady = false;
    let gates = 0;
    let choiceDismissals = 0;
    let surveyDismissals = 0;
    let nudges = 0;
    let triages = 0;
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
        throw new Error(
          `claude exited (code ${this.exitCode}) while waiting for ready. ` +
            `Screen at exit: ${this.exitTail || "(not captured)"}`,
        );
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
        // Frozen screen — run the recovery ladder before giving up. A static
        // screen usually means "idle in a footer variant the regexes don't know",
        // not "dead" (see docs/AUTOPILOT_brain_resilience.md).
        // Rung 1: transcript growth = claude IS working; the screen just isn't moving.
        const ts = await transcriptStat(this.cfg.cwd, this.sessionId);
        if (ts && Date.now() - ts.mtimeMs < TRANSCRIPT_ACTIVE_MS) {
          lastChangeAt = Date.now();
          continue;
        }
        // Rung 2: a reply landed after our injection and the transcript's tail is
        // a final assistant message → the turn is OVER; the screen was just an
        // unrecognized idle variant. Success, not death.
        if (
          sinceOffset !== undefined &&
          ts &&
          ts.size > sinceOffset &&
          (await transcriptTurnEnded(this.cfg.cwd, this.sessionId))
        ) {
          return gates;
        }
        // Rung 3: repaint nudge — resize the PTY by one column and back, forcing
        // the TUI to redraw fully. Cures a stale/partial render and gives the
        // classifier a fresh screen. One shot.
        if (nudges < 1) {
          nudges += 1;
          this.nudgeRepaint();
          lastChangeAt = Date.now();
          await sleep(2000);
          continue;
        }
        // Rung 4: ask the local brain to triage the screen (bounded). It may
        // recognize a menu/survey/picker the regexes don't and suggest ONE safe
        // key (Enter/Esc/digit — enforced here, never free text).
        if (this.onTriage && triages < MAX_TRIAGES) {
          triages += 1;
          let triage: ScreenTriage | null = null;
          try {
            triage = await this.onTriage(text);
          } catch {
            /* triage is best-effort; a brain hiccup falls through to the timeout */
          }
          if (triage?.state === "ready" && !requireThink) return gates; // boot: idle variant confirmed
          const key = triageKeyBytes(triage?.key);
          if (key) {
            this.type(key);
            lastChangeAt = Date.now();
            await sleep(GATE_COOLDOWN_MS);
            continue;
          }
        }
        fail(`claude's screen was frozen for ${(stuckMs / 1000).toFixed(0)}s and never became ready`);
      }
      if (detectAuthError(text)) {
        throw new AuthError("claude reported an authentication error (401). Run `claude` and `/login`.");
      }
      if (detectRateLimit(text)) {
        throw new RateLimitError("claude hit the subscription usage limit — pausing this session.");
      }

      // Dismiss the feedback survey if it pops up mid-turn. Current builds want
      // "0: Dismiss" (Esc does nothing — the old Esc-only path spammed it for 8
      // minutes and died); attempts alternate 0/Esc to cover both TUI builds.
      if (detectFeedbackSurvey(text)) {
        if (surveyDismissals >= MAX_SURVEY_DISMISSALS) {
          fail(`the feedback survey did not dismiss after ${surveyDismissals} attempts`);
        }
        this.type(this.surveyKey(surveyDismissals++));
        await sleep(GATE_COOLDOWN_MS);
        continue;
      }

      // Claude opened an AskUserQuestion choice menu — it wants the operator to pick
      // from a list. Under autopilot no one is at the keyboard, and the menu is modal:
      // it never settles to "ready", so left alone it freezes the turn until the
      // stuck-timeout fires (the "agent stuck when Claude proposes options" bug).
      // Esc-dismiss it so the turn ends; the question is recorded in the transcript,
      // and the brain answers it in plain text on the next turn (its autonomy persona
      // may escalate to a human). Guard against an endless re-ask loop within a turn.
      if (detectChoicePrompt(text)) {
        if (++choiceDismissals > MAX_CHOICE_DISMISSALS) {
          fail(`Claude reopened a choice menu ${choiceDismissals} times without progressing`);
        }
        this.type(ESC);
        sawNonReady = true;
        readySince = null;
        await sleep(GATE_COOLDOWN_MS);
        continue;
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

  /** Force a full TUI repaint by resizing the PTY one column down and back. */
  private nudgeRepaint(): void {
    try {
      this.term?.resize(COLS - 1, ROWS);
      this.screen.resize(COLS - 1, ROWS);
      this.term?.resize(COLS, ROWS);
      this.screen.resize(COLS, ROWS);
    } catch {
      /* a dead pty surfaces via exited on the next poll */
    }
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

  /**
   * Read the REAL context-window usage from Claude's `/context` panel (a local
   * command, no model usage). Returns the used fraction (0..1) or null. Drive
   * ONLY when idle. The panel is tall, so read the scrollback (fullText).
   */
  async readContextFraction(): Promise<number | null> {
    if (!this.term || this.exited) return null;
    this.type("/context");
    await sleep(900); // let the slash-command menu settle before Enter
    this.type("\r");
    await sleep(3800); // the /context panel renders progressively
    const text = this.screen.fullText(160);
    this.type(ESC); // close the panel
    await sleep(300);
    return parseContextFraction(text);
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
