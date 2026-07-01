/**
 * Per-session notification overrides. A single noisy (or sensitive) session can
 * opt out of lifecycle notifications entirely, or narrow them to just the events
 * that matter — without touching the global webhook/quiet-hours config.
 *
 * This is a PURE policy over a session's override + the firing event: it decides
 * whether the session's OWN lifecycle notification should be delivered. It does
 * not touch the transport, the webhook list, or automation rules (an explicit
 * automation `notify` action is separate operator intent and is unaffected).
 */
import type { WebhookEvent } from "../types.js";

/** The lifecycle events a session can be notified about (mirror of WebhookEvent). */
export const NOTIFY_EVENTS: readonly WebhookEvent[] = [
  "done",
  "error",
  "stopped",
  "needs-input",
  "rate-limited",
];

/**
 * A session's notification override.
 * - `mute` silences EVERY lifecycle notification for this session.
 * - `events` (when non-empty) is an allow-list: only these events notify.
 * Both omitted (or the whole override omitted) = default fleet behavior.
 */
export interface SessionNotifyOverride {
  /** When true, this session fires no lifecycle notifications at all. */
  mute?: boolean;
  /** Allow-list of events that DO notify; empty/undefined = all events. */
  events?: WebhookEvent[];
}

/** Is `e` a known lifecycle event? */
export function isNotifyEvent(e: unknown): e is WebhookEvent {
  return typeof e === "string" && (NOTIFY_EVENTS as readonly string[]).includes(e);
}

/**
 * Should this session's `event` lifecycle notification be delivered, given its
 * override? No override → yes. Muted → no. An allow-list → only listed events.
 */
export function sessionNotifies(ov: SessionNotifyOverride | undefined, event: WebhookEvent): boolean {
  if (!ov) return true;
  if (ov.mute) return false;
  if (ov.events && ov.events.length > 0) return ov.events.includes(event);
  return true;
}

/**
 * Clean untrusted input into a stored override, or `undefined` when it carries no
 * meaning (not muted + no allow-list) so the config stays free of empty objects.
 * Dedupes + drops unknown events, preserving canonical event order.
 */
export function normalizeNotifyOverride(input: unknown): SessionNotifyOverride | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as { mute?: unknown; events?: unknown };
  const mute = o.mute === true;
  let events: WebhookEvent[] | undefined;
  if (Array.isArray(o.events)) {
    const seen = new Set<WebhookEvent>();
    for (const e of o.events) if (isNotifyEvent(e)) seen.add(e);
    // Keep canonical order for stable persistence + display.
    if (seen.size) events = NOTIFY_EVENTS.filter((e) => seen.has(e));
  }
  if (!mute && !events) return undefined;
  return { ...(mute ? { mute: true } : {}), ...(events ? { events } : {}) };
}
