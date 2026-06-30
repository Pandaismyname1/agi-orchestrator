/**
 * Goal-intake suggestions (AI tooling, deterministic — no LLM).
 *
 * When the operator drafts a new session, two things are tedious to figure out
 * by hand:
 *   1. which existing TEMPLATE best fits the goal they're typing, and
 *   2. which existing session this new one should RUN AFTER (`dependsOn`).
 *
 * Both are inferred here with cheap, explainable heuristics over the project's
 * own history (existing templates + sessions), so they're fully testable and
 * never call out anywhere. The intake LLM call handles clarity separately; these
 * suggestions are merged onto its result.
 */
import type { SessionTemplate } from "../types.js";

export interface TemplateSuggestion {
  id: string;
  name: string;
  /** Why it was suggested (e.g. "matches: tests, fix"). */
  reason: string;
  /** Internal ranking score (higher = stronger match). */
  score: number;
}

export interface DependsOnSuggestion {
  id: string;
  /** Short label = the candidate session's goal, truncated. */
  label: string;
  reason: string;
  score: number;
}

/** A session as the suggester needs to see it (decoupled from Managed/SessionConfig). */
export interface SessionLite {
  id: string;
  goal: string;
  cwd: string;
}

export interface DependsInput {
  /** Absolute cwd of the new session (already resolved by the caller). */
  cwd?: string;
  goal: string;
  /** Exclude this id from candidates (when editing an existing session). */
  excludeId?: string;
}

// Words too common to carry meaning for keyword overlap.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "into", "from", "your", "you", "are",
  "will", "its", "it's", "all", "any", "can", "use", "via", "out", "not", "but", "has",
  "have", "was", "were", "they", "them", "then", "than", "when", "what", "which", "who",
  "should", "would", "could", "make", "made", "get", "got", "set", "new", "add", "run",
  "running", "until", "every", "some", "more", "most", "each", "per", "one", "two", "also",
  "project", "session", "agent", "claude", "code", "task", "goal", "done", "criteria",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords + tokens shorter than 3. */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function tokenSet(s: string): Set<string> {
  return new Set(tokenize(s));
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const t of a) if (b.has(t)) out.push(t);
  return out;
}

/** Compare two paths for "same project" — case-insensitive, trailing-slash-insensitive. */
function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Rank templates by keyword overlap with the goal. Name-token matches count
 * double (a template named "Bug-fix sprint" should win for a bug-fix goal even
 * if its stored goal text is short). Returns the top `limit` with score >= 1.
 */
export function suggestTemplates(
  goal: string,
  templates: SessionTemplate[],
  limit = 3,
): TemplateSuggestion[] {
  const goalTokens = tokenSet(goal);
  if (goalTokens.size === 0) return [];

  const scored: TemplateSuggestion[] = [];
  for (const t of templates) {
    const nameTokens = tokenSet(t.name ?? "");
    const bodyTokens = tokenSet(`${t.goal ?? ""} ${t.description ?? ""}`);
    const nameShared = intersect(goalTokens, nameTokens);
    const bodyShared = intersect(goalTokens, bodyTokens);
    // Union of matched terms for the reason; score weights name hits double.
    const matched = [...new Set([...nameShared, ...bodyShared])];
    const score = nameShared.length * 2 + bodyShared.length;
    if (score < 1) continue;
    scored.push({
      id: t.id,
      name: t.name,
      reason: `matches: ${matched.slice(0, 3).join(", ")}`,
      score,
    });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

// A goal with a DOWNSTREAM verb tends to run after an UPSTREAM one in the same
// project (e.g. "deploy the site" runs after "build the site").
const DOWNSTREAM = ["deploy", "publish", "release", "ship", "launch", "host", "serve", "promote", "rollout", "rollback"];
const UPSTREAM = ["build", "create", "implement", "write", "develop", "scaffold", "generate", "design", "setup", "bootstrap", "finish", "complete"];

function hasAny(tokens: Set<string>, verbs: string[]): string | undefined {
  for (const v of verbs) if (tokens.has(v)) return v;
  return undefined;
}

/**
 * Suggest existing sessions the new one should run after. Only same-project
 * (same cwd) sessions are eligible — a cross-project dependency rarely makes
 * sense. A downstream-verb goal (deploy/publish/…) paired with an upstream-verb
 * candidate (build/create/…) is the strongest signal; plain keyword overlap is a
 * weaker one. Returns the top `limit` candidates.
 */
export function suggestDependsOn(
  input: DependsInput,
  sessions: SessionLite[],
  limit = 3,
): DependsOnSuggestion[] {
  if (!input.cwd) return []; // no project to match against
  const goalTokens = tokenSet(input.goal);
  const downstream = hasAny(goalTokens, DOWNSTREAM);

  const scored: DependsOnSuggestion[] = [];
  for (const s of sessions) {
    if (s.id === input.excludeId) continue;
    if (!samePath(s.cwd, input.cwd)) continue;

    const candTokens = tokenSet(s.goal);
    let score = 2; // same project, baseline
    let reason = "same project";

    const upstream = downstream ? hasAny(candTokens, UPSTREAM) : undefined;
    if (downstream && upstream) {
      score += 4;
      reason = `${downstream} usually runs after ${upstream} — same project`;
    } else {
      const shared = intersect(goalTokens, candTokens);
      if (shared.length) {
        score += Math.min(shared.length, 3);
        reason = `same project; shares: ${shared.slice(0, 3).join(", ")}`;
      }
    }
    scored.push({ id: s.id, label: truncate(s.goal, 60), reason, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
