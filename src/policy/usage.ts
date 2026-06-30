/**
 * Real subscription-limit tracking — replaces the artificial daily turn/minute
 * budget. Claude Code's own `/usage` panel reports the limits that actually
 * gate the account, which we parse from the TUI:
 *
 *   Current session            13% used   Resets 10:49am (Europe/Bucharest)
 *   Current week (all models)  35% used   Resets Jun 30, 10:59pm (Europe/Bucharest)
 *   Current week (Sonnet only)  0% used
 *
 * - "Current session" is the rolling ~5h window.
 * - "Current week (all models)" is the weekly cap (Opus + everything).
 * - "Current week (Sonnet only)" is the larger Sonnet-only weekly pool that
 *   Claude falls back to once the all-models weekly cap is hit.
 *
 * We pause a session when its governing limit is spent and auto-resume at the
 * reported reset time. Parsing is pure + unit-tested against real captures.
 */

export interface LimitWindow {
  /** Percent of this limit used (0–100). */
  pct: number;
  /** The raw "Resets …" text as shown, if present. */
  resetText?: string;
  /** Parsed reset time (epoch ms), if we could resolve it. */
  resetAt?: number;
}

export interface UsageStatus {
  session?: LimitWindow;
  weeklyAll?: LimitWindow;
  weeklySonnet?: LimitWindow;
  /** When this snapshot was read (epoch ms). */
  capturedAt: number;
}

export interface UsageGuardOptions {
  /** Master switch. When off, the usage gate is inert. Default true. */
  enabled?: boolean;
  /** Pause a session when a governing limit reaches this percent. Default 100. */
  pauseAtPercent?: number;
  /**
   * When the weekly all-models (Opus) cap is spent but the Sonnet-only pool has
   * room, Claude Code auto-runs on Sonnet. "continue" keeps working on Sonnet
   * (default — more gets done); "pause" stops until the weekly reset instead.
   */
  onOpusExhausted?: "continue" | "pause";
  /** Re-read /usage every N completed turns (a local command, no model usage). Default 5. */
  refreshEveryTurns?: number;
}

export interface UsageVerdict {
  /** True when the session should pause. */
  blocked: boolean;
  /** Human-readable why. */
  reason: string;
  /** Epoch ms to auto-resume at (the relevant reset), if known. */
  resumeAt?: number;
  /** True when running degraded on Sonnet (Opus weekly spent, Sonnet has room). */
  sonnetOnly: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Parse a "Resets …" string into an absolute epoch (ms). Handles both
 * "10:49am (Europe/Bucharest)" (time-only, today/next) and
 * "Jun 30, 10:59pm (Europe/Bucharest)" (dated). The displayed timezone is the
 * machine's local zone, so we build a local Date. `now` is injectable for tests.
 */
export function parseResetAt(resetText: string | undefined, now: number): number | undefined {
  if (!resetText) return undefined;
  const s = resetText.replace(/\([^)]*\)/, "").trim(); // drop "(Europe/Bucharest)"

  const to24h = (h: number, ap: string): number => {
    const m = ap.toLowerCase();
    if (m === "pm" && h !== 12) return h + 12;
    if (m === "am" && h === 12) return 0;
    return h;
  };

  // Dated: "Jun 30, 10:59pm" or "Jun 30, 11pm" (minutes optional / on-the-hour).
  const dated = s.match(/([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
  if (dated) {
    const mon = MONTHS.indexOf(dated[1]!.toLowerCase());
    const day = Number(dated[2]);
    const hour = to24h(Number(dated[3]), dated[5]!);
    const min = Number(dated[4] ?? "0");
    if (mon >= 0) {
      const ref = new Date(now);
      let year = ref.getFullYear();
      let when = new Date(year, mon, day, hour, min, 0, 0).getTime();
      // Year rollover (e.g. "Jan 2" seen in late December).
      if (when < now - 8 * 24 * 60 * 60 * 1000) {
        when = new Date(year + 1, mon, day, hour, min, 0, 0).getTime();
      }
      return when;
    }
  }

  // Time-only: "10:49am" or "11pm" → today at that time, or tomorrow if passed.
  const timeOnly = s.match(/(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i);
  if (timeOnly) {
    const hour = to24h(Number(timeOnly[1]), timeOnly[3]!);
    const min = Number(timeOnly[2] ?? "0");
    const ref = new Date(now);
    let when = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hour, min, 0, 0).getTime();
    if (when <= now) when += 24 * 60 * 60 * 1000;
    return when;
  }
  return undefined;
}

/** Pull one limit window's {pct, reset} out of the slice following its header. */
function parseWindow(slice: string, now: number): LimitWindow | undefined {
  const pctM = slice.match(/(\d+)\s*%\s*used/i);
  if (!pctM) return undefined;
  const pct = Number(pctM[1]);
  const resetM = slice.match(/Resets\s+([^\n\r]+)/i);
  const resetText = resetM ? resetM[1]!.trim() : undefined;
  return { pct, resetText, resetAt: parseResetAt(resetText, now) };
}

/** Parse the full `/usage` screen text into a UsageStatus. */
export function parseUsage(text: string, now: number = Date.now()): UsageStatus {
  // Bound each section to the text between its header and the next header so a
  // window's reset line can't leak into a later one.
  const headers: [keyof Omit<UsageStatus, "capturedAt">, RegExp][] = [
    ["session", /Current session/i],
    ["weeklyAll", /Current week \(all models\)/i],
    ["weeklySonnet", /Current week \(Sonnet only\)/i],
  ];
  const marks = headers
    .map(([key, re]) => ({ key, idx: text.search(re), re }))
    .filter((m) => m.idx >= 0)
    .sort((a, b) => a.idx - b.idx);

  const status: UsageStatus = { capturedAt: now };
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i]!.idx;
    const end = i + 1 < marks.length ? marks[i + 1]!.idx : text.length;
    // Also stop at the "What's contributing" explainer that follows the windows.
    const explain = text.indexOf("What's contributing", start);
    const sliceEnd = explain >= 0 && explain < end ? explain : end;
    const win = parseWindow(text.slice(start, sliceEnd), now);
    if (win) status[marks[i]!.key] = win;
  }
  return status;
}

/**
 * Decide whether a session should pause given the current usage. Session (5h)
 * exhaustion pauses until the session resets. Weekly all-models exhaustion only
 * pauses if Sonnet is ALSO spent (or the user chose to pause on Opus-exhaustion);
 * otherwise Claude runs on Sonnet and we keep going (flagged sonnetOnly).
 */
export function usageVerdict(status: UsageStatus, opts: UsageGuardOptions = {}): UsageVerdict {
  const cap = opts.pauseAtPercent ?? 100;
  const onOpus = opts.onOpusExhausted ?? "continue";
  const spent = (w?: LimitWindow): boolean => !!w && w.pct >= cap;

  // Session (5h) window — the most immediate gate.
  if (spent(status.session)) {
    return {
      blocked: true,
      reason: `session limit reached (${status.session!.pct}% of the 5-hour window)`,
      resumeAt: status.session!.resetAt,
      sonnetOnly: false,
    };
  }

  const opusSpent = spent(status.weeklyAll);
  const sonnetSpent = spent(status.weeklySonnet);

  // Weekly: hard stop only when even the Sonnet pool is spent.
  if (opusSpent && sonnetSpent) {
    return {
      blocked: true,
      reason: `weekly limit reached (all models ${status.weeklyAll!.pct}%, Sonnet ${status.weeklySonnet!.pct}%)`,
      resumeAt: status.weeklyAll?.resetAt ?? status.weeklySonnet?.resetAt,
      sonnetOnly: false,
    };
  }

  // Opus weekly spent but Sonnet has room.
  if (opusSpent) {
    if (onOpus === "pause") {
      return {
        blocked: true,
        reason: `weekly Opus (all-models) limit reached (${status.weeklyAll!.pct}%); paused per config`,
        resumeAt: status.weeklyAll?.resetAt,
        sonnetOnly: true,
      };
    }
    return {
      blocked: false,
      reason: `running on Sonnet — weekly all-models cap reached (${status.weeklyAll!.pct}%)`,
      sonnetOnly: true,
    };
  }

  return { blocked: false, reason: "", sonnetOnly: false };
}

/**
 * Stateless helper the orchestrator uses to decide when to re-read /usage and
 * how to read a verdict. Off (enabled:false) → the gate never blocks.
 */
export class UsageGuard {
  constructor(private readonly opts: UsageGuardOptions | undefined) {}

  get enabled(): boolean {
    return this.opts?.enabled !== false && !!this.opts;
  }
  get refreshEveryTurns(): number {
    return Math.max(1, this.opts?.refreshEveryTurns ?? 5);
  }
  /** Should we re-read /usage after this many completed turns? */
  shouldRefresh(turnCount: number): boolean {
    return this.enabled && turnCount > 0 && turnCount % this.refreshEveryTurns === 0;
  }
  verdict(status: UsageStatus): UsageVerdict {
    if (!this.enabled) return { blocked: false, reason: "", sonnetOnly: false };
    return usageVerdict(status, this.opts ?? {});
  }
}
