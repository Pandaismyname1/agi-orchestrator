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
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Encode an absolute cwd the way Claude Code names its project transcript folder. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
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
