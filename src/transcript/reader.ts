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
