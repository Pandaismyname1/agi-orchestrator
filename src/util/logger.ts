/**
 * Structured logger with size-based file rotation. The orchestrator runs
 * unattended for hours, so a durable, parseable log is the difference between
 * "it broke overnight, no idea why" and a clean post-mortem.
 *
 * - Levels (debug < info < warn < error) gated by a configurable minimum.
 * - Pretty, colorless lines to the console; JSON lines to an optional file.
 * - The file rotates when it would exceed `maxBytes`: `app.log` → `app.log.1`,
 *   `.1` → `.2`, …, dropping the oldest beyond `maxFiles`.
 *
 * The format + rotation MATH are pure functions (unit-tested); the `Logger`
 * class does the I/O with a single best-effort guard so a logging failure can
 * never crash a run.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Minimum level to emit. Default "info". */
  level?: LogLevel;
  /** File to append JSON lines to. Omit for console-only (default). */
  file?: string;
  /** Rotate when the file would exceed this many bytes. Default 5 MiB. */
  maxBytes?: number;
  /** Keep this many rotated files (`.1`…`.N`). Default 5. */
  maxFiles?: number;
  /** Also mirror to the console. Default true. */
  console?: boolean;
}

/** Extra structured fields attached to a log entry. */
export type Fields = Record<string, unknown>;

/** True when `level` should be emitted given the configured `min`. */
export function levelEnabled(min: LogLevel, level: LogLevel): boolean {
  return ORDER[level] >= ORDER[min];
}

/** A single JSON-line record (stable key order: ts, level, msg, …fields). */
export function formatLine(level: LogLevel, msg: string, fields: Fields, iso: string): string {
  const rec: Record<string, unknown> = { ts: iso, level, msg };
  for (const [k, v] of Object.entries(fields)) {
    if (k !== "ts" && k !== "level" && k !== "msg") rec[k] = v;
  }
  return JSON.stringify(rec);
}

/** A human-friendly console line. */
export function prettyLine(level: LogLevel, msg: string, fields: Fields, iso: string): string {
  const extra = Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
  return `${iso} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
}

/**
 * The filesystem ops to rotate `file`, keeping `maxFiles` generations. Returns an
 * ordered plan: unlink the about-to-be-overwritten oldest, then rename the chain
 * from highest index down to the base, so applying it top-to-bottom never clobbers
 * a file we still need. (Pure — performs no I/O.)
 */
export function rotationPlan(
  file: string,
  maxFiles: number,
): { unlink: string | null; renames: Array<{ from: string; to: string }> } {
  const keep = Math.max(1, Math.floor(maxFiles));
  // The oldest we keep is `.${keep}`; it gets dropped to make room.
  const unlink = `${file}.${keep}`;
  const renames: Array<{ from: string; to: string }> = [];
  for (let n = keep - 1; n >= 1; n--) {
    renames.push({ from: `${file}.${n}`, to: `${file}.${n + 1}` });
  }
  renames.push({ from: file, to: `${file}.1` });
  return { unlink, renames };
}

const DEFAULTS = { level: "info" as LogLevel, maxBytes: 5 * 1024 * 1024, maxFiles: 5, console: true };

export class Logger {
  private readonly opts: Required<Omit<LoggerOptions, "file">> & { file?: string };
  private readonly now: () => Date;
  private readonly bound: Fields;
  private dirReady = false;

  constructor(options: LoggerOptions = {}, deps: { now?: () => Date } = {}, bound: Fields = {}) {
    this.opts = {
      level: options.level ?? DEFAULTS.level,
      file: options.file,
      maxBytes: options.maxBytes && options.maxBytes > 0 ? Math.floor(options.maxBytes) : DEFAULTS.maxBytes,
      maxFiles: options.maxFiles && options.maxFiles > 0 ? Math.floor(options.maxFiles) : DEFAULTS.maxFiles,
      console: options.console ?? DEFAULTS.console,
    };
    this.now = deps.now ?? (() => new Date());
    this.bound = bound;
  }

  /** A child logger that tags every entry with `fields` (e.g. {session: id}). */
  child(fields: Fields): Logger {
    return new Logger({ ...this.opts }, { now: this.now }, { ...this.bound, ...fields });
  }

  debug(msg: string, fields?: Fields): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.log("error", msg, fields);
  }

  private log(level: LogLevel, msg: string, fields?: Fields): void {
    if (!levelEnabled(this.opts.level, level)) return;
    const merged = { ...this.bound, ...(fields ?? {}) };
    const iso = this.now().toISOString();
    if (this.opts.console) {
      const line = prettyLine(level, msg, merged, iso);
      if (level === "error" || level === "warn") console.error(line);
      else console.log(line);
    }
    if (this.opts.file) {
      try {
        this.writeFile(formatLine(level, msg, merged, iso) + "\n");
      } catch {
        // A logging failure must never break a run — drop the file line silently.
      }
    }
  }

  private writeFile(line: string): void {
    const file = this.opts.file!;
    if (!this.dirReady) {
      mkdirSync(dirname(file), { recursive: true });
      this.dirReady = true;
    }
    // Rotate BEFORE writing if this line would push us past the cap.
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0; // not created yet
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.opts.maxBytes) {
      this.rotate();
    }
    appendFileSync(file, line);
  }

  private rotate(): void {
    const { unlink, renames } = rotationPlan(this.opts.file!, this.opts.maxFiles);
    if (unlink && existsSync(unlink)) {
      try {
        rmSync(unlink, { force: true });
      } catch {
        /* best-effort */
      }
    }
    for (const { from, to } of renames) {
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

/** Build a logger from optional config (console-only when no file is set). */
export function createLogger(options?: LoggerOptions, deps?: { now?: () => Date }): Logger {
  return new Logger(options ?? {}, deps);
}
