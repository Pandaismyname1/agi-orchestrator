/**
 * Persisted workflow-builder toolbar preferences: the link mode (what dragging a
 * handle creates — a dependency, or a start/stop automation) and the trigger event
 * a drawn automation fires on. Like fleet prefs (see prefs.ts), the parse/serialize
 * logic is pure + validated so it's unit-testable without a DOM; the load/save
 * wrappers touch localStorage behind try/catch so disabled storage degrades to
 * defaults rather than throwing.
 */
import { DRAW_EVENTS } from "./drawauto";
import type { WebhookEvent } from "./types";

/** What a drawn handle-link creates. Mirrors WorkflowModal's LinkMode. */
export type LinkMode = "depends" | "start" | "stop";

export interface WorkflowPrefs {
  linkMode: LinkMode;
  drawEvent: WebhookEvent;
}

const KEY = "agi.wf.prefs.v1";
const DEFAULT_MODE: LinkMode = "depends";
const DEFAULT_EVENT: WebhookEvent = "done";
const VALID_MODE = new Set<string>(["depends", "start", "stop"]);
const VALID_EVENT = new Set<string>(DRAW_EVENTS);

export const defaultWorkflowPrefs = (): WorkflowPrefs => ({ linkMode: DEFAULT_MODE, drawEvent: DEFAULT_EVENT });

/** Coerce an unknown value to a valid LinkMode, falling back to the default. */
export function coerceLinkMode(v: unknown): LinkMode {
  return typeof v === "string" && VALID_MODE.has(v) ? (v as LinkMode) : DEFAULT_MODE;
}

/** Coerce an unknown value to a valid draw event, falling back to the default. */
export function coerceDrawEvent(v: unknown): WebhookEvent {
  return typeof v === "string" && VALID_EVENT.has(v) ? (v as WebhookEvent) : DEFAULT_EVENT;
}

/** Parse stored JSON into validated prefs. Bad/empty input → defaults (never throws). */
export function parseWorkflowPrefs(raw: string | null | undefined): WorkflowPrefs {
  if (!raw) return defaultWorkflowPrefs();
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return { linkMode: coerceLinkMode(o?.linkMode), drawEvent: coerceDrawEvent(o?.drawEvent) };
  } catch {
    return defaultWorkflowPrefs();
  }
}

/** Serialize prefs to the stored JSON shape (both fields re-validated). */
export function serializeWorkflowPrefs(p: WorkflowPrefs): string {
  return JSON.stringify({ linkMode: coerceLinkMode(p.linkMode), drawEvent: coerceDrawEvent(p.drawEvent) });
}

/** Read persisted prefs from localStorage (defaults if unavailable). */
export function loadWorkflowPrefs(): WorkflowPrefs {
  try {
    return parseWorkflowPrefs(localStorage.getItem(KEY));
  } catch {
    return defaultWorkflowPrefs();
  }
}

/** Persist prefs to localStorage (no-op if storage is unavailable). */
export function saveWorkflowPrefs(p: WorkflowPrefs): void {
  try {
    localStorage.setItem(KEY, serializeWorkflowPrefs(p));
  } catch {
    /* private mode / storage disabled — fine, just won't persist */
  }
}
