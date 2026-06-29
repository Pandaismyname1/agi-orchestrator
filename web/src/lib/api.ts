/**
 * Read-only REST helpers for the observability + discovery endpoints
 * (the live fleet state comes over the WebSocket, not these).
 */
import type {
  AttachInput,
  DiscoveredSession,
  DraftProposal,
  LearningSummary,
  Metrics,
  OperatorProfile,
  RunDetail,
  RunRow,
} from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** Design/demo mode: serve canned history/transcript data instead of hitting the API. */
const isMock = (): boolean => new URLSearchParams(location.search).has("mock");

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export const api = {
  discover: () => getJson<DiscoveredSession[]>("/api/discover"),
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
  /** Register a hand-started session for hook-attach driving (POST /attach). */
  attach: (input: AttachInput) =>
    postJson<{ ok: boolean; error?: string }>("/attach", input),
  detach: (session_id: string) =>
    postJson<{ ok: boolean }>("/detach", { session_id }),
};
