/**
 * Pure helpers for drawing automation edges on the workflow canvas. When the
 * operator drags a start/stop link between two nodes, these build the rule and
 * pick a sensible default trigger event — kept DOM-free so the rule shape and
 * naming are unit-testable.
 */
import type { AutomationInput, WebhookEvent } from "./types";

export type DrawKind = "start" | "stop";

/** The events offered in the per-draw picker, in a sensible order. */
export const DRAW_EVENTS: WebhookEvent[] = ["done", "error", "stopped", "needs-input", "rate-limited"];

/** Sensible default trigger for a freshly-chosen action: start-on-done, stop-on-error. */
export function defaultEventFor(kind: DrawKind): WebhookEvent {
  return kind === "start" ? "done" : "error";
}

const PHRASE: Record<WebhookEvent, string> = {
  done: "is done",
  error: "errors",
  stopped: "is stopped",
  "needs-input": "needs input",
  "rate-limited": "is rate-limited",
};

/** Human phrase for an event, used in a rule's auto-generated name. */
export function eventPhrase(e: WebhookEvent): string {
  return PHRASE[e] ?? e;
}

export interface DrawnAutomationArgs {
  from: string;
  to: string;
  kind: DrawKind;
  event: WebhookEvent;
  /** Display labels for the rule name (default to the raw ids). */
  fromLabel?: string;
  toLabel?: string;
}

/**
 * Build the automation rule a drawn edge represents: "when FROM fires <event>,
 * <kind> TO". Scoped to the firing session via match.sessionId so it doesn't
 * apply fleet-wide.
 */
export function buildDrawnAutomation(a: DrawnAutomationArgs): AutomationInput {
  const f = a.fromLabel ?? a.from;
  const t = a.toLabel ?? a.to;
  const verb = a.kind === "start" ? "Start" : "Stop";
  return {
    name: `${verb} ${t} when ${f} ${eventPhrase(a.event)}`,
    enabled: true,
    on: [a.event],
    match: { sessionId: a.from },
    actions: [{ kind: a.kind, target: a.to }],
  };
}
