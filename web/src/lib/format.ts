/** Small presentation helpers shared across components. */

export function minutes(m: number | null | undefined): string {
  return m ? `${m.toFixed(1)}m` : "—";
}

export function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export function statusLabel(status: string): string {
  return status === "needs-input" ? "needs you" : status;
}

/** A short, human label for the brain's last decision line. */
export function clamp(text: string, n: number): string {
  return text.length > n ? text.slice(0, n) + "…" : text;
}
