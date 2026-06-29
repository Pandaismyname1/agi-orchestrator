/**
 * Read-only REST helpers for the observability + discovery endpoints
 * (the live fleet state comes over the WebSocket, not these).
 */
import type { DiscoveredSession, Metrics, RunDetail, RunRow } from "./types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  discover: () => getJson<DiscoveredSession[]>("/api/discover"),
  runs: (sessionId: string) =>
    getJson<RunRow[]>(`/api/runs?session=${encodeURIComponent(sessionId)}`),
  metrics: (sessionId: string) =>
    getJson<Metrics>(`/api/metrics?session=${encodeURIComponent(sessionId)}`),
  run: (id: number) => getJson<RunDetail>(`/api/run?id=${id}`),
};
