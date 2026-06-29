/**
 * VirtualScreen — a headless terminal emulator that turns the raw PTY byte
 * stream into clean, readable screen text.
 *
 * Why this exists: Claude Code's TUI does NOT print plain text. It renders the
 * screen with ANSI escape sequences — words are separated by cursor-movement
 * codes (e.g. ESC[1C), not spaces, and the screen is repainted in place. Naive
 * substring/regex matching on the raw stream fails. We feed the stream into a
 * real VT emulator (@xterm/headless) and read back the rendered grid as text.
 *
 * Used by the engine to:
 *   - detect interactive gates (trust dialog, MCP approval, permission prompts)
 *   - detect "ready for input" state
 * Assistant message CONTENT is read from the transcript JSONL instead — this is
 * only for driving the live TUI.
 */
import { createRequire } from "node:module";
import type { Terminal as XtermTerminal } from "@xterm/headless";

// @xterm/headless ships as CommonJS with no named ESM export, so load it via require.
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

export class VirtualScreen {
  private term: XtermTerminal;

  constructor(cols = 100, rows = 30) {
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 5000,
    });
  }

  /** Feed raw PTY output into the emulator. */
  write(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** The full visible viewport as clean text, one line per row, trailing blanks trimmed. */
  visibleText(): string {
    const buf = this.term.buffer.active;
    const top = buf.viewportY;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(top + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines.join("\n").replace(/\n+$/g, "");
  }

  /** Recent scrollback + viewport as clean text — useful for scanning a whole turn. */
  fullText(maxLines = 400): string {
    const buf = this.term.buffer.active;
    const total = buf.length; // scrollback + viewport
    const start = Math.max(0, total - maxLines);
    const lines: string[] = [];
    for (let y = start; y < total; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines.join("\n");
  }

  dispose(): void {
    this.term.dispose();
  }
}
