/**
 * Stuck / oscillation detection.
 *
 * A session is "making progress" when files in its project change. If the brain
 * keeps saying "continue" but NOTHING on disk changes for several turns in a row,
 * the agent is probably spinning (re-reading the same files, re-planning, looping)
 * — burning turns and rate-limit budget for nothing. We detect that and escalate
 * to the human instead of letting it grind.
 *
 * The detector itself is pure (it's fed a directory fingerprint each turn), so it
 * unit-tests without a filesystem. `fingerprintDir` provides the real fingerprint.
 */
import { readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", ".claude", ".idea", ".scratch"]);
const MAX_ENTRIES = 5000;

/**
 * A cheap fingerprint of a project's files (path + size + mtime). Changes when
 * the agent creates/edits/deletes anything. Skips noise dirs; caps work for big
 * trees. Never throws — returns a best-effort hash.
 */
export function fingerprintDir(dir: string): string {
  const parts: string[] = [];
  let count = 0;
  const walk = (d: string): void => {
    if (count >= MAX_ENTRIES) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (count >= MAX_ENTRIES) return;
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else {
        parts.push(`${full}:${st.size}:${Math.round(st.mtimeMs)}`);
        count++;
      }
    }
  };
  walk(dir);
  parts.sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

export class StuckDetector {
  private lastFp: string | undefined;
  private noChange = 0;

  /** Record this turn's post-turn directory fingerprint. */
  record(fingerprint: string): void {
    if (this.lastFp !== undefined && fingerprint === this.lastFp) this.noChange += 1;
    else this.noChange = 0;
    this.lastFp = fingerprint;
  }

  /** True once files have been unchanged for `threshold` consecutive turns. */
  isStuck(threshold: number): boolean {
    return threshold > 0 && this.noChange >= threshold;
  }

  /** Consecutive no-change turns so far. */
  get streak(): number {
    return this.noChange;
  }

  /** Reset after the human redirects, giving the new approach room to work. */
  reset(): void {
    this.noChange = 0;
  }
}
