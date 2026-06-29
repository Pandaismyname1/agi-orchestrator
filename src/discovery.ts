/**
 * SessionDiscovery — find Claude Code sessions that already exist on disk so you
 * can adopt/resume them in the cockpit (P2), not just ones we created.
 *
 * Claude Code stores a transcript per session at
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * We scan that tree and pull lightweight metadata from each transcript: the real
 * working directory (from the entries' `cwd`), a one-line summary (first user
 * message), an assistant-turn count, and last-activity time (file mtime).
 *
 * The scan root is injectable so it can be unit-tested against a temp directory.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface DiscoveredSession {
  sessionId: string;
  /** Project directory the session ran in (from the transcript, falls back to the encoded dir). */
  cwd: string;
  /** First user message, truncated — a human-readable hint of what it's about. */
  summary: string;
  /** Number of assistant turns recorded. */
  turns: number;
  /** Last-activity timestamp (transcript mtime, ms). */
  lastActivity: number;
}

const MAX_PARSE_BYTES = 4_000_000; // skip pathologically huge transcripts

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") {
      const t = (b as Record<string, unknown>).text;
      if (typeof t === "string") out.push(t);
    }
  }
  return out.join(" ").trim();
}

/** Parse one transcript file for discovery metadata. Never throws. */
async function parseTranscript(file: string): Promise<Omit<DiscoveredSession, "sessionId" | "lastActivity"> | null> {
  let raw: string;
  try {
    const st = await stat(file);
    if (st.size > MAX_PARSE_BYTES) return { cwd: "", summary: "(large transcript)", turns: 0 };
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  let cwd = "";
  let summary = "";
  let turns = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
    const msg = e.message as Record<string, unknown> | undefined;
    const role = e.type === "assistant" || msg?.role === "assistant" ? "assistant" : e.type === "user" || msg?.role === "user" ? "user" : "";
    if (role === "assistant") turns++;
    if (role === "user" && !summary && msg) {
      const txt = textFromContent(msg.content);
      if (txt && !txt.startsWith("<")) summary = txt.replace(/\s+/g, " ").slice(0, 120);
    }
  }
  return { cwd, summary, turns };
}

export class SessionDiscovery {
  constructor(private readonly root = path.join(os.homedir(), ".claude", "projects")) {}

  /** List existing sessions, most-recently-active first. */
  async list(limit = 50): Promise<DiscoveredSession[]> {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(this.root);
    } catch {
      return [];
    }

    const out: DiscoveredSession[] = [];
    for (const dir of projectDirs) {
      const dirPath = path.join(this.root, dir);
      let files: string[];
      try {
        files = await readdir(dirPath);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(dirPath, f);
        let mtime = 0;
        try {
          mtime = (await stat(full)).mtimeMs;
        } catch {
          continue;
        }
        const meta = await parseTranscript(full);
        if (!meta) continue;
        out.push({
          sessionId: f.replace(/\.jsonl$/, ""),
          cwd: meta.cwd || dir,
          summary: meta.summary || "(no summary)",
          turns: meta.turns,
          lastActivity: mtime,
        });
      }
    }

    out.sort((a, b) => b.lastActivity - a.lastActivity);
    return out.slice(0, limit);
  }
}
