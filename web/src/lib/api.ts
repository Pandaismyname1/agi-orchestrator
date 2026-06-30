/**
 * Read-only REST helpers for the observability + discovery endpoints
 * (the live fleet state comes over the WebSocket, not these).
 */
import type {
  Analytics,
  AttachInput,
  CatalogEntry,
  HealthReport,
  RegistryResult,
  RunningClaude,
  DiscoveredSession,
  DraftProposal,
  IntakeResult,
  LearningSummary,
  Metrics,
  OperatorProfile,
  RunDetail,
  RunRow,
} from "./types";
import { auth } from "./auth.svelte";

/** A 401 mid-session means the token was rotated/revoked — drop to the login gate. */
function handle401(status: number): void {
  if (status === 401) auth.invalidate();
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: auth.authHeaders() });
  if (!res.ok) {
    handle401(res.status);
    throw new Error(`${url} → ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Design/demo mode: serve canned history/transcript data instead of hitting the API. */
const isMock = (): boolean => new URLSearchParams(location.search).has("mock");

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth.authHeaders() },
    body: JSON.stringify(body),
  });
  handle401(res.status);
  return (await res.json()) as T;
}

export const api = {
  discover: () =>
    isMock()
      ? import("./mock").then((m) => m.MOCK_DISCOVER)
      : getJson<DiscoveredSession[]>("/api/discover"),
  runs: (sessionId: string) =>
    isMock()
      ? import("./mock").then((m) => m.MOCK_RUNS)
      : getJson<RunRow[]>(`/api/runs?session=${encodeURIComponent(sessionId)}`),
  metrics: (sessionId: string) =>
    isMock()
      ? import("./mock").then((m) => m.MOCK_METRICS)
      : getJson<Metrics>(`/api/metrics?session=${encodeURIComponent(sessionId)}`),
  run: (id: number) =>
    isMock() ? import("./mock").then((m) => m.MOCK_RUN) : getJson<RunDetail>(`/api/run?id=${id}`),
  /** Learning loop: profile summary, the pending draft, and version history. */
  learning: () =>
    isMock()
      ? import("./mock").then((m) => m.MOCK_LEARNING)
      : getJson<LearningSummary>("/api/learning"),
  learningDraft: (scope?: string) =>
    isMock()
      ? import("./mock").then((m) => m.MOCK_DRAFT)
      : getJson<DraftProposal | null>(
          `/api/learning/draft${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`,
        ),
  learningVersions: (scope?: string) =>
    isMock()
      ? import("./mock").then((m) => m.MOCK_VERSIONS)
      : getJson<OperatorProfile[]>(
          `/api/learning/versions${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`,
        ),
  /** Goal intake assistant: assess a goal/done-criteria for clarity (one LLM call). */
  intake: (input: { cwd?: string; goal: string; doneCriteria: string }): Promise<IntakeResult> =>
    isMock()
      ? Promise.resolve({
          clarity: "vague",
          assessment: "The goal is broad — scope and a checkable finish line would help.",
          questions: [
            "Which modules/areas are in scope vs out of scope?",
            "What does 'done' look like concretely — tests passing, a deployed build, a PR?",
            "Any constraints (frameworks, files to avoid, perf targets)?",
          ],
          suggestedGoal: `${input.goal.trim()} — limited to the affected module, leaving public APIs unchanged.`,
          suggestedDoneCriteria: `${input.doneCriteria.trim()}; the full test suite passes and a summary of changes is written.`,
          suggestedTemplates: [
            { id: "tpl-bugfix", name: "Bug-fix sprint", reason: "matches: fix, tests, bugs", score: 5 },
            { id: "tpl-audit", name: "Security audit", reason: "matches: audit", score: 1 },
          ],
          suggestedDependsOn: [
            { id: "demo-website", label: "Build the one-page coffee shop website", reason: "deploy usually runs after build — same project", score: 6 },
          ],
        })
      : postJson<IntakeResult>("/api/intake", input),
  /** Built-in starter-template catalog with installed flags (GET /api/catalog). */
  catalog: (): Promise<CatalogEntry[]> =>
    isMock() ? import("./mock").then((m) => m.MOCK_CATALOG) : getJson<CatalogEntry[]>("/api/catalog"),
  /** Remote community recipe registry (GET /api/registry). */
  registry: (): Promise<RegistryResult> =>
    isMock() ? import("./mock").then((m) => m.MOCK_REGISTRY) : getJson<RegistryResult>("/api/registry"),
  /** System health / diagnostics (GET /api/health). */
  health: (): Promise<HealthReport> =>
    isMock() ? import("./mock").then((m) => m.MOCK_HEALTH) : getJson<HealthReport>("/api/health"),
  /** Fleet + per-session performance analytics (GET /api/analytics). */
  analytics: (): Promise<Analytics> =>
    isMock() ? import("./mock").then((m) => m.MOCK_ANALYTICS) : getJson<Analytics>("/api/analytics"),
  /** Running `claude` processes on this machine, for one-click attach. */
  runningClaude: (): Promise<RunningClaude[]> =>
    isMock()
      ? import("./mock").then((m) => m.MOCK_RUNNING)
      : getJson<RunningClaude[]>("/api/running-claude"),
  /** Register a hand-started session for hook-attach driving (POST /attach). */
  attach: (input: AttachInput) =>
    postJson<{ ok: boolean; error?: string }>("/attach", input),
  detach: (session_id: string) =>
    postJson<{ ok: boolean }>("/detach", { session_id }),
};
