/**
 * Past-session miner (A3). Walks existing Claude Code transcripts on disk and
 * extracts examples of how the owner steered the agent: whenever a `user`
 * message immediately follows an `assistant` message, that pair is "agent said
 * X → human corrected with Y". We collect those pairs into an example bank,
 * both globally and per-project (keyed by the session's cwd).
 *
 * This is pure read-side mining: it never touches the database and never throws
 * on a bad session — a malformed/huge transcript is just skipped. Downstream
 * synthesis turns the returned items into a draft operator profile.
 */
import { discoverAll } from "../discovery.js";
import { readRecentMessages } from "../transcript/reader.js";
import type { ExampleBankItem } from "./types.js";
import { hashExample, truncate } from "./util.js";

export interface MineResult {
  /** All mined examples across every scanned session, deduped by hash. */
  global: ExampleBankItem[];
  /** Mined examples grouped by the session's absolute cwd, each deduped. */
  byCwd: Map<string, ExampleBankItem[]>;
  /** How many sessions we actually walked. */
  sessionsScanned: number;
}

const DEFAULT_SCAN_LIMIT = 60;
const DEFAULT_MAX_PER_SESSION = 20;
/** Hard ceiling on the flat global list, to bound memory on a huge tree. */
const MAX_GLOBAL_ITEMS = 5000;

/** Skip empty, too-short, or tool/system-block user messages. */
function isNoiseInstruction(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return true;
  if (t.startsWith("<")) return true; // <command-name>, <local-command…>, etc.
  return false;
}

/**
 * Merge one example into a list, deduping by hash: if the hash is already
 * present bump its `count` and keep the max `lastSeen`, otherwise append.
 */
function upsert(
  list: ExampleBankItem[],
  index: Map<string, ExampleBankItem>,
  item: ExampleBankItem,
): void {
  const existing = index.get(item.hash);
  if (existing) {
    existing.count++;
    if (item.lastSeen > existing.lastSeen) existing.lastSeen = item.lastSeen;
    return;
  }
  index.set(item.hash, item);
  list.push(item);
}

/**
 * Mine steering examples from recent on-disk Claude Code sessions.
 *
 * For each session we read ALL messages (oldest→newest) and look for every
 * `user` turn that directly follows an `assistant` turn — the assistant text is
 * the `situation`, the user text is the `instruction`. Noise (tool/system
 * blocks, empty/short text) and the leading user message are skipped.
 */
export async function mineExamples(opts?: {
  root?: string;
  desktopRoot?: string;
  scanLimit?: number;
  maxPerSession?: number;
}): Promise<MineResult> {
  const scanLimit = opts?.scanLimit ?? DEFAULT_SCAN_LIMIT;
  const maxPerSession = opts?.maxPerSession ?? DEFAULT_MAX_PER_SESSION;

  // CLI ∪ Desktop sessions (deduped). Desktop sessions carry projectCwd so a
  // worktree session is attributed to its real project, not the worktree dir.
  let sessions: Awaited<ReturnType<typeof discoverAll>>;
  try {
    sessions = await discoverAll(scanLimit, opts?.root, opts?.desktopRoot);
  } catch {
    return { global: [], byCwd: new Map(), sessionsScanned: 0 };
  }

  const global: ExampleBankItem[] = [];
  const globalIndex = new Map<string, ExampleBankItem>();
  const byCwd = new Map<string, ExampleBankItem[]>();
  const cwdIndex = new Map<string, Map<string, ExampleBankItem>>();
  let sessionsScanned = 0;

  for (const s of sessions) {
    let msgs: Awaited<ReturnType<typeof readRecentMessages>>;
    try {
      msgs = await readRecentMessages(s.cwd, s.sessionId, -1);
    } catch {
      continue; // never throw on a bad session — skip it
    }
    sessionsScanned++;

    // Group by the real project (originCwd for Desktop worktree sessions), so a
    // session's examples land in the right per-project bank.
    const groupCwd = s.projectCwd || s.cwd;

    // Per-cwd output list + dedupe index (created lazily).
    let cwdList = byCwd.get(groupCwd);
    let cwdIdx = cwdIndex.get(groupCwd);
    if (!cwdList || !cwdIdx) {
      cwdList = [];
      cwdIdx = new Map<string, ExampleBankItem>();
      byCwd.set(groupCwd, cwdList);
      cwdIndex.set(groupCwd, cwdIdx);
    }

    let mintedThisSession = 0;
    for (let i = 1; i < msgs.length; i++) {
      if (mintedThisSession >= maxPerSession) break;
      const prev = msgs[i - 1];
      const cur = msgs[i];
      // user message immediately following an assistant message
      if (!prev || !cur) continue;
      if (cur.role !== "user" || prev.role !== "assistant") continue;
      if (isNoiseInstruction(cur.text)) continue;

      const situation = truncate(prev.text, 300);
      const instruction = truncate(cur.text, 300);
      const item: ExampleBankItem = {
        situation,
        instruction,
        source: "past",
        hash: hashExample(situation, instruction),
        count: 1,
        lastSeen: s.lastActivity,
      };

      // A fresh item per (list) so dedupe counts don't alias across scopes.
      if (global.length < MAX_GLOBAL_ITEMS) {
        upsert(global, globalIndex, { ...item });
      }
      upsert(cwdList, cwdIdx, { ...item });
      mintedThisSession++;
    }
  }

  return { global, byCwd, sessionsScanned };
}
