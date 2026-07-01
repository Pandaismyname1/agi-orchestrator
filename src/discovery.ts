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
import { OpenCodeDiscovery } from "./opencode.js";

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
  /**
   * Where it came from: the Claude Code CLI store, the Claude Desktop app (its
   * embedded Claude Code), or the OpenCode CLI.
   */
  source?: "cli" | "desktop" | "opencode";
  /** Desktop/OpenCode sessions carry a human title; CLI sessions don't. */
  title?: string;
  /** The real project root (Desktop runs in a git worktree under originCwd). For grouping/mining. */
  projectCwd?: string;
  /** False when the transcript is gone (archived / worktree removed) so it can't be resumed. */
  resumable?: boolean;
  /**
   * Whether this orchestrator can DRIVE the session (spawn/resume it in a PTY it
   * owns). Claude Code CLI + Desktop sessions are drivable (`claude --resume`);
   * OpenCode sessions are surfaced + minable but not drivable. Undefined = true.
   */
  drivable?: boolean;
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
          source: "cli",
          resumable: true,
        });
      }
    }

    out.sort((a, b) => b.lastActivity - a.lastActivity);
    return out.slice(0, limit);
  }

  /** Set of session ids (transcript basenames) present in the CLI store. */
  async transcriptIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    let dirs: string[];
    try {
      dirs = await readdir(this.root);
    } catch {
      return ids;
    }
    for (const dir of dirs) {
      let files: string[];
      try {
        files = await readdir(path.join(this.root, dir));
      } catch {
        continue;
      }
      for (const f of files) if (f.endsWith(".jsonl")) ids.add(f.replace(/\.jsonl$/, ""));
    }
    return ids;
  }
}

/** Default location of Claude Desktop's embedded-Claude-Code session descriptors. */
export function defaultDesktopRoot(): string {
  return path.join(os.homedir(), "AppData", "Roaming", "Claude", "claude-code-sessions");
}

interface DesktopDescriptor {
  cliSessionId?: string;
  cwd?: string;
  originCwd?: string;
  title?: string;
  model?: string;
  createdAt?: number;
  lastActivityAt?: number;
  isArchived?: boolean;
}

/**
 * Discover sessions from the Claude DESKTOP app. Desktop's "agent mode" runs the
 * embedded Claude Code and records a descriptor per session under
 *   ~/AppData/Roaming/Claude/claude-code-sessions/<id>/<id>/local_*.json
 * Each descriptor has a `cliSessionId` (a real Claude Code session id), the run
 * cwd / origin project, a human title, and timestamps. The actual transcript —
 * when it still exists — lives in the SAME ~/.claude/projects store the CLI uses,
 * so a Desktop session with a present transcript is resumable + minable exactly
 * like a CLI one.
 */
export class DesktopDiscovery {
  constructor(
    private readonly root = defaultDesktopRoot(),
    private readonly cliRoot = path.join(os.homedir(), ".claude", "projects"),
  ) {}

  private async readDescriptors(): Promise<DesktopDescriptor[]> {
    const out: DesktopDescriptor[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.name.startsWith("local_") && e.name.endsWith(".json")) {
          try {
            out.push(JSON.parse(await readFile(p, "utf8")) as DesktopDescriptor);
          } catch {
            /* skip unparseable descriptor */
          }
        }
      }
    };
    await walk(this.root, 0);
    return out;
  }

  /** List Desktop sessions (those with a cliSessionId), most-recent first. */
  async list(limit = 80, transcriptIds?: Set<string>): Promise<DiscoveredSession[]> {
    const descriptors = await this.readDescriptors();
    const present =
      transcriptIds ?? (await new SessionDiscovery(this.cliRoot).transcriptIds());

    const out: DiscoveredSession[] = [];
    for (const d of descriptors) {
      const id = d.cliSessionId;
      if (!id || id === "undefined") continue; // descriptor with no underlying CC session
      const runCwd = d.cwd || d.originCwd || "";
      out.push({
        sessionId: id,
        cwd: runCwd,
        projectCwd: d.originCwd || runCwd,
        summary: d.title || "(untitled desktop session)",
        title: d.title,
        turns: 0, // descriptors don't carry a turn count; transcript parse is too costly here
        lastActivity: d.lastActivityAt ?? d.createdAt ?? 0,
        source: "desktop",
        resumable: present.has(id),
      });
    }
    // newest first; dedupe descriptors that point at the same cliSessionId (keep newest)
    out.sort((a, b) => b.lastActivity - a.lastActivity);
    const seen = new Set<string>();
    const deduped = out.filter((s) => (seen.has(s.sessionId) ? false : (seen.add(s.sessionId), true)));
    return deduped.slice(0, limit);
  }
}

/**
 * Merge Claude Code CLI + Claude Desktop + OpenCode discovery into one list,
 * deduped by session id. When a Claude session is in both CLI and Desktop, keep
 * the CLI entry's parsed cwd/turns but adopt the Desktop title + project + the
 * "desktop" source (it's the friendlier label). OpenCode session ids (`ses_…`)
 * never collide with Claude's UUIDs, so they merge in cleanly.
 */
export async function discoverAll(
  limit = 80,
  cliRoot?: string,
  desktopRoot?: string,
  opencodeRoot?: string,
): Promise<DiscoveredSession[]> {
  const cliDisc = new SessionDiscovery(cliRoot);
  const [cli, ids] = await Promise.all([cliDisc.list(500), cliDisc.transcriptIds()]);
  const [desktop, opencode] = await Promise.all([
    new DesktopDiscovery(desktopRoot, cliRoot).list(500, ids),
    new OpenCodeDiscovery(opencodeRoot).list(500),
  ]);

  const byId = new Map<string, DiscoveredSession>();
  for (const s of cli) byId.set(s.sessionId, s);
  for (const d of desktop) {
    const existing = byId.get(d.sessionId);
    if (existing) {
      byId.set(d.sessionId, {
        ...existing,
        source: "desktop",
        title: d.title,
        projectCwd: d.projectCwd,
        summary: d.title || existing.summary,
      });
    } else {
      byId.set(d.sessionId, d);
    }
  }
  for (const o of opencode) if (!byId.has(o.sessionId)) byId.set(o.sessionId, o);
  return [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, limit);
}
