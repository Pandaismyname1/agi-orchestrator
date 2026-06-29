/**
 * Small shared helpers for the learning loop, so the miner, live-signal
 * derivation, synthesis, and eval all normalize / hash / compare text the same
 * way (cross-source dedupe depends on a single hash).
 */

/** Lowercase, collapse whitespace, trim — for comparison + hashing. */
export function normalize(s: string): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Truncate to ~n chars on a word boundary, appending … if cut. */
export function truncate(s: string, n: number): string {
  const t = (s ?? "").trim();
  if (t.length <= n) return t;
  return t.slice(0, n).replace(/\s+\S*$/, "").trimEnd() + "…";
}

/** Stable hex hash (FNV-1a) of a normalized (situation, instruction) pair. */
export function hashExample(situation: string, instruction: string): string {
  const input = normalize(situation) + "␟" + normalize(instruction);
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Token set of significant words (length ≥ 2). */
export function tokenSet(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter((w) => w.length >= 2));
}

/** Jaccard overlap (0..1) of two strings' token sets. */
export function jaccard(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Two instructions count as "the same" if normalized-equal or near-identical. */
export function sameInstruction(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalize(a ?? "");
  const nb = normalize(b ?? "");
  if (!na || !nb) return false;
  if (na === nb) return true;
  return jaccard(na, nb) >= 0.9;
}
