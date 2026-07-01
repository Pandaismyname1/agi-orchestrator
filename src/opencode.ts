/**
 * OpenCode support — discover and read sessions from the OpenCode CLI
 * (opencode.ai / github.com/sst/opencode), the second interactive coding agent
 * this orchestrator understands besides Claude Code / Claude Desktop.
 *
 * OpenCode stores everything under a per-user data dir (XDG data home; on Windows
 * that's ~/.local/share/opencode). The shape we read:
 *
 *   storage/session/<projectID>/<sessionID>.json   — one session descriptor
 *     { id, slug, projectID, directory, title, time:{ created, updated } }
 *   storage/project/<projectID>.json               — the project root
 *     { id, worktree, vcs, ... }
 *   storage/message/<sessionID>/<messageID>.json    — one message (role only)
 *     { id, sessionID, role:"user"|"assistant", time:{ created }, ... }
 *   storage/part/<messageID>/<partID>.json          — a message's content parts
 *     { id, messageID, type:"text"|"reasoning"|"tool"|..., text?, ... }
 *
 * Note the split: a message file carries the ROLE but no text; the visible text
 * lives in its `type:"text"` PART files. So reading a conversation means joining
 * message → parts.
 *
 * Everything here is read-only and defensive: an absent dir, a malformed JSON
 * file, or an odd shape is skipped, never thrown. The format is internal to
 * OpenCode and can change between versions, so we tolerate missing fields.
 *
 * The scan root is injectable so it can be unit-tested against a temp directory.
 *
 * These sessions can be surfaced (Adopt browser) and mined for the learning loop,
 * but they are NOT drivable by this orchestrator — it drives Claude Code through a
 * PTY (`claude --resume <id>`), which cannot resume an OpenCode `ses_…` id. See
 * `DiscoveredSession.drivable`.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiscoveredSession } from "./discovery.js";

/** Default OpenCode data dir. Honors $XDG_DATA_HOME, else ~/.local/share. */
export function defaultOpenCodeRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode");
}

const MAX_TURN_COUNT_READS = 2000; // don't read a pathological message dir just to count turns

interface OpenCodeSession {
  id?: string;
  slug?: string;
  projectID?: string;
  directory?: string;
  title?: string;
  /** Present on sub-agent sessions; we surface only top-level sessions. */
  parentID?: string;
  time?: { created?: number; updated?: number };
}

interface OpenCodeProject {
  id?: string;
  worktree?: string;
}

interface OpenCodeMessage {
  id?: string;
  role?: string;
  time?: { created?: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export class OpenCodeDiscovery {
  private readonly sessionRoot: string;
  private readonly projectRoot: string;
  private readonly messageRoot: string;
  private readonly partRoot: string;
  /** projectID → worktree, memoized across a single scan. */
  private worktreeCache = new Map<string, string | undefined>();

  constructor(private readonly root = defaultOpenCodeRoot()) {
    const storage = path.join(root, "storage");
    this.sessionRoot = path.join(storage, "session");
    this.projectRoot = path.join(storage, "project");
    this.messageRoot = path.join(storage, "message");
    this.partRoot = path.join(storage, "part");
  }

  /** The project's real root (worktree), memoized. Falls back to undefined. */
  private async worktreeFor(projectID: string): Promise<string | undefined> {
    if (this.worktreeCache.has(projectID)) return this.worktreeCache.get(projectID);
    const proj = await readJson<OpenCodeProject>(path.join(this.projectRoot, `${projectID}.json`));
    const wt = typeof proj?.worktree === "string" ? proj.worktree : undefined;
    this.worktreeCache.set(projectID, wt);
    return wt;
  }

  /** Count assistant messages in a session (its "turns"). Bounded + never throws. */
  private async countAssistantTurns(sessionID: string): Promise<number> {
    let files: string[];
    try {
      files = await readdir(path.join(this.messageRoot, sessionID));
    } catch {
      return 0;
    }
    const jsons = files.filter((f) => f.endsWith(".json"));
    if (jsons.length > MAX_TURN_COUNT_READS) return jsons.length; // too many to classify cheaply
    let turns = 0;
    for (const f of jsons) {
      const msg = await readJson<OpenCodeMessage>(path.join(this.messageRoot, sessionID, f));
      if (msg?.role === "assistant") turns++;
    }
    return turns;
  }

  /** List OpenCode sessions, most-recently-active first. Never throws. */
  async list(limit = 80): Promise<DiscoveredSession[]> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.sessionRoot);
    } catch {
      return [];
    }

    const out: DiscoveredSession[] = [];
    for (const projectID of projectDirs) {
      const dir = path.join(this.sessionRoot, projectID);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const full = path.join(dir, f);
        const session = await readJson<OpenCodeSession>(full);
        if (!session || typeof session.id !== "string") continue;
        if (session.parentID) continue; // skip sub-agent sessions; surface top-level only

        const worktree = session.projectID
          ? await this.worktreeFor(session.projectID)
          : undefined;
        const cwd = session.directory || worktree || "";
        let lastActivity = session.time?.updated ?? session.time?.created ?? 0;
        if (!lastActivity) {
          try {
            lastActivity = (await stat(full)).mtimeMs;
          } catch {
            /* leave 0 */
          }
        }

        out.push({
          sessionId: session.id,
          cwd,
          projectCwd: worktree || cwd,
          summary: session.title || "(untitled opencode session)",
          title: session.title,
          turns: await this.countAssistantTurns(session.id),
          lastActivity,
          source: "opencode",
          // Present + minable, but this orchestrator can't resume it (it drives claude).
          resumable: true,
          drivable: false,
        });
      }
    }

    out.sort((a, b) => b.lastActivity - a.lastActivity);
    return out.slice(0, limit);
  }
}

/** Concatenate the visible `text` parts of one OpenCode message. Never throws. */
async function textForMessage(partRoot: string, messageID: string): Promise<string> {
  let files: string[];
  try {
    files = await readdir(path.join(partRoot, messageID));
  } catch {
    return "";
  }
  const parts: Array<{ id: string; text: string }> = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const part = await readJson<Record<string, unknown>>(path.join(partRoot, messageID, f));
    if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text) {
      parts.push({ id: typeof part.id === "string" ? part.id : f, text: part.text });
    }
  }
  // Part ids are time-sortable within a message; keep authored order.
  parts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return parts.map((p) => p.text).join("\n").trim();
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "…";
}

/**
 * Read an OpenCode session's user/assistant messages in chronological order
 * (oldest→newest), each text truncated to ~600 chars — the same shape
 * `readRecentMessages` returns for Claude Code, so the learning miner can treat
 * both sources identically. `maxMessages < 0` returns all. Never throws.
 */
export async function readOpenCodeMessages(
  sessionId: string,
  root = defaultOpenCodeRoot(),
  maxMessages = 8,
): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  const storage = path.join(root, "storage");
  const messageRoot = path.join(storage, "message");
  const partRoot = path.join(storage, "part");

  let files: string[];
  try {
    files = await readdir(path.join(messageRoot, sessionId));
  } catch {
    return [];
  }

  // Load message headers so we can order by creation time (id is the tiebreaker).
  const headers: OpenCodeMessage[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const msg = await readJson<OpenCodeMessage>(path.join(messageRoot, sessionId, f));
    if (msg && typeof msg.id === "string") headers.push(msg);
  }
  headers.sort((a, b) => {
    const ta = a.time?.created ?? 0;
    const tb = b.time?.created ?? 0;
    if (ta !== tb) return ta - tb;
    return (a.id ?? "") < (b.id ?? "") ? -1 : 1;
  });

  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const msg of headers) {
    const role = msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : null;
    if (!role || !msg.id) continue;
    const text = await textForMessage(partRoot, msg.id);
    if (!text) continue;
    out.push({ role, text: truncateText(text, 600) });
  }
  return maxMessages >= 0 ? out.slice(-maxMessages) : out;
}

/**
 * Last non-empty assistant text in an OpenCode session, or "" if none. Mirrors
 * `readLastAssistantMessage` for Claude Code. Never throws.
 */
export async function readLastOpenCodeAssistant(
  sessionId: string,
  root = defaultOpenCodeRoot(),
): Promise<string> {
  const msgs = await readOpenCodeMessages(sessionId, root, -1);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "assistant" && m.text) return m.text;
  }
  return "";
}
