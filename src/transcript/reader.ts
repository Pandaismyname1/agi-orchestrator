/**
 * Read claude's last assistant message from the on-disk transcript.
 *
 * We force a known session id via `claude --session-id <uuid>`, so we know the
 * exact transcript file:
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * where <encoded-cwd> is the absolute cwd with every non-alphanumeric char
 * replaced by '-'  (e.g. C:\Users\panda\Desktop\AGI -> C--Users-panda-Desktop-AGI).
 *
 * The JSONL line format is INTERNAL to Claude Code and can change between
 * versions, so we parse defensively: tolerate unknown shapes, extract text
 * blocks from assistant entries, and never throw on a malformed line.
 */
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Encode an absolute cwd the way Claude Code names its project transcript folder. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Render an `AskUserQuestion` tool call into readable text so the brain (acting as
 * the operator) can answer it. The interactive menu never settles to a turn-end on
 * its own — the session Esc-dismisses it — so surfacing the question here is how the
 * brain learns what decision Claude wanted. Shape (Claude Code internal):
 *   { questions: [{ question, header, multiSelect, options: [{ label, description }] }] }
 * Parsed defensively: any missing/odd field is skipped, never throws.
 */
function renderAskUserQuestion(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions) || questions.length === 0) return "";
  const blocks: string[] = [];
  questions.forEach((q, qi) => {
    if (!q || typeof q !== "object") return;
    const qr = q as Record<string, unknown>;
    const header = typeof qr.header === "string" && qr.header ? ` (${qr.header})` : "";
    const text = typeof qr.question === "string" ? qr.question : "";
    const multi = qr.multiSelect === true ? " [choose one or more]" : "";
    const lines = [`Q${qi + 1}${header}: ${text}${multi}`];
    const opts = Array.isArray(qr.options) ? qr.options : [];
    opts.forEach((o, oi) => {
      if (!o || typeof o !== "object") return;
      const or = o as Record<string, unknown>;
      const label = typeof or.label === "string" ? or.label : "";
      const desc =
        typeof or.description === "string" && or.description ? ` — ${or.description}` : "";
      lines.push(`   ${oi + 1}. ${label}${desc}`);
    });
    blocks.push(lines.join("\n"));
  });
  if (blocks.length === 0) return "";
  return (
    "[Claude opened a choice menu and is asking you to decide. Reply in plain language — " +
    "name the option(s) you want, or give a different instruction.]\n" +
    blocks.join("\n")
  );
}

/** Pull concatenated text from a content array of mixed blocks. */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      // Surface a pending operator question (AskUserQuestion) as text so the brain
      // can answer it — the menu itself never reaches a normal turn-end.
      else if (b.type === "tool_use" && b.name === "AskUserQuestion") {
        const rendered = renderAskUserQuestion(b.input);
        if (rendered) parts.push(rendered);
      }
    }
  }
  return parts.join("\n").trim();
}

/** Is this parsed line an assistant message? Tolerate a couple of shapes. */
function assistantText(entry: Record<string, unknown>): string {
  const msg = entry.message as Record<string, unknown> | undefined;
  if (entry.type === "assistant" && msg) return textFromContent(msg.content);
  if (msg && msg.role === "assistant") return textFromContent(msg.content);
  return "";
}

/**
 * Classify a parsed line as a user/assistant message and extract its text.
 * Returns null for entries that aren't user/assistant messages or have no text.
 * Tolerates a couple of shapes, mirroring `assistantText` above.
 */
function roleAndText(
  entry: Record<string, unknown>,
): { role: "user" | "assistant"; text: string } | null {
  const msg = entry.message as Record<string, unknown> | undefined;
  let role: "user" | "assistant" | undefined;
  if (entry.type === "assistant" || (msg && msg.role === "assistant")) role = "assistant";
  else if (entry.type === "user" || (msg && msg.role === "user")) role = "user";
  if (!role) return null;
  const text = textFromContent(msg?.content);
  if (!text) return null;
  return { role, text };
}

/** Truncate to ~maxLen chars, appending an ellipsis if anything was cut. */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "…";
}

/**
 * Return the last `maxMessages` user/assistant messages from the transcript, in
 * chronological order (oldest→newest). User entries are the prompts we injected;
 * assistant entries are claude's replies. Each message's text is truncated to
 * ~600 chars. Never throws — returns [] if the file is missing or unparseable.
 */
export async function readRecentMessages(
  cwd: string,
  sessionId: string,
  maxMessages = 8,
): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(cwd, sessionId), "utf8");
  } catch {
    return [];
  }
  return messagesFromRaw(raw, maxMessages);
}

/**
 * Pure parse of transcript JSONL into the last `maxMessages` user/assistant
 * messages (oldest→newest), each truncated to ~600 chars. Exported so it can be
 * unit-tested without touching the real `~/.claude` transcript tree.
 */
export function messagesFromRaw(
  raw: string,
  maxMessages = 8,
): Array<{ role: "user" | "assistant"; text: string }> {
  const all: Array<{ role: "user" | "assistant"; text: string }> = [];
  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const rt = roleAndText(entry);
    if (!rt) continue;
    all.push({ role: rt.role, text: truncateText(rt.text, 600) });
  }
  return maxMessages >= 0 ? all.slice(-maxMessages) : all;
}

/**
 * Return the last non-empty assistant text in the transcript, or "" if none yet.
 * Returns "" (not an error) if the file doesn't exist — caller treats that as
 * "no message available yet".
 */
export async function readLastAssistantMessage(cwd: string, sessionId: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(cwd, sessionId), "utf8");
  } catch {
    return "";
  }
  return lastAssistantFromRaw(raw);
}

/**
 * Can this conversation actually be `--resume`d? File EXISTENCE is not enough:
 * the TUI writes mode/permission metadata lines before the first user message,
 * and `claude --resume` exits 1 ("No conversation found") on a transcript with
 * no message entries — a first-turn crash can leave exactly such a poison file,
 * which would exit-1 every respawn forever. Resume only when at least one real
 * message entry exists; otherwise the caller re-mints the id via --session-id.
 * Sync (used on the boot path). Never throws.
 */
export function transcriptResumable(cwd: string, sessionId: string): boolean {
  try {
    const raw = readFileSync(transcriptPath(cwd, sessionId), "utf8");
    return messagesFromRaw(raw, 1).length > 0;
  } catch {
    return false;
  }
}

/**
 * Ground-truth liveness: size + mtime of the transcript file. The transcript is
 * appended continuously WHILE claude works, so recent growth = real progress even
 * when the rendered screen looks frozen — and a quiet file disambiguates "stuck"
 * from "idle but the screen regexes didn't recognize the footer". Returns null
 * when the transcript doesn't exist yet.
 */
export async function transcriptStat(
  cwd: string,
  sessionId: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(transcriptPath(cwd, sessionId));
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Pure turn-end check on raw transcript JSONL: TRUE when the LAST message entry
 * is an assistant message whose content is final text (no tool_use in flight).
 * While a turn runs, the tail is a tool_use assistant entry or a tool_result user
 * entry; when it finishes, claude appends the closing text-only assistant message.
 * Non-message entries (progress/system/summary) are skipped. Conservative: an
 * unparseable or empty tail returns false.
 */
export function turnEndedInRaw(raw: string): boolean {
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message as Record<string, unknown> | undefined;
    const isAssistant = entry.type === "assistant" || (msg && msg.role === "assistant");
    const isUser = entry.type === "user" || (msg && msg.role === "user");
    if (!isAssistant && !isUser) continue; // progress/system/summary — skip
    if (!isAssistant) return false; // user entry last: injected prompt or tool_result → in flight
    const content = msg?.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (!Array.isArray(content)) return false;
    // Final message = has text, and is NOT awaiting a tool result.
    const hasToolUse = content.some(
      (b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_use",
    );
    const hasText = content.some(
      (b) =>
        b &&
        typeof b === "object" &&
        (b as Record<string, unknown>).type === "text" &&
        typeof (b as Record<string, unknown>).text === "string" &&
        ((b as Record<string, unknown>).text as string).trim().length > 0,
    );
    return hasText && !hasToolUse;
  }
  return false;
}

/** Disk wrapper for `turnEndedInRaw`. False when the transcript is missing. */
export async function transcriptTurnEnded(cwd: string, sessionId: string): Promise<boolean> {
  try {
    const raw = await readFile(transcriptPath(cwd, sessionId), "utf8");
    return turnEndedInRaw(raw);
  } catch {
    return false;
  }
}

/**
 * The last assistant text that appears strictly AFTER `byteOffset` in the
 * transcript, or null if none. Used by turn recovery: the orchestrator records
 * the transcript size before injecting a prompt; after a kill+resume it can tell
 * whether the reply already landed (→ don't re-inject, don't double-execute).
 * The slice starts at the first newline past the offset so a mid-line cut can't
 * corrupt the first parsed entry.
 */
export async function assistantTextAfterOffset(
  cwd: string,
  sessionId: string,
  byteOffset: number,
): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(transcriptPath(cwd, sessionId));
  } catch {
    return null;
  }
  if (buf.length <= byteOffset) return null;
  let start = byteOffset;
  if (start > 0) {
    const nl = buf.indexOf(0x0a, start - 1); // include an entry that starts exactly at offset
    if (nl === -1) return null;
    start = nl + 1;
  }
  const text = lastAssistantFromRaw(buf.subarray(start).toString("utf8"));
  return text ? text : null;
}

/**
 * Pure parse of transcript JSONL: the last non-empty assistant text, or "" if
 * none. A trailing `AskUserQuestion` (a tool_use-only assistant message) now
 * renders as text, so a pending operator question is returned here too. Exported
 * for unit testing without disk I/O.
 */
export function lastAssistantFromRaw(raw: string): string {
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = assistantText(entry);
    if (text) return text;
  }
  return "";
}
