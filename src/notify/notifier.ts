/**
 * Outbound event notifications ("automation suite"). When a session reaches a
 * notable lifecycle moment — finished, errored, paused for a human decision, or
 * hit a real subscription limit — the orchestrator fires any matching webhooks.
 *
 * Best-effort and non-blocking: a slow or failing endpoint never stalls a run.
 * Payloads are plain JSON, or Slack/Discord chat-message shaped, so a webhook
 * can drop straight into a Slack/Discord "Incoming Webhook" with zero glue.
 *
 * This is just an outbound HTTP POST to a URL the operator configured — it makes
 * NO model calls, so it's orthogonal to the subscription-safety guard.
 */
import type { QuietHours, WebhookConfig, WebhookEvent } from "../types.js";
import { suppresses } from "../policy/quiethours.js";

/** Everything a notification message can mention about the session that fired it. */
export interface NotifyContext {
  id: string;
  /** Short human label (the goal head, usually). */
  label: string;
  cwd: string;
  goal: string;
  status: string;
  turns: number;
  elapsedMin: number;
  /** Optional extra line: the stop reason, the error, or the escalation question. */
  detail?: string;
}

/** The JSON body delivered for the generic "json" format. */
export interface NotifyPayload {
  event: WebhookEvent;
  message: string;
  session: {
    id: string;
    label: string;
    cwd: string;
    goal: string;
    status: string;
    turns: number;
    elapsedMin: number;
  };
  detail?: string;
  /** Epoch ms. */
  timestamp: number;
}

/** Result of one delivery attempt. */
export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Injectable transport (real one uses global fetch; tests pass a recorder). */
export type PostFn = (url: string, jsonBody: string) => Promise<DeliveryResult>;

const ALL_EVENTS: WebhookEvent[] = ["done", "error", "stopped", "needs-input", "rate-limited"];

const EMOJI: Record<WebhookEvent, string> = {
  done: "✅",
  error: "❌",
  stopped: "⏹️",
  "needs-input": "🟡",
  "rate-limited": "⏳",
};

const VERB: Record<WebhookEvent, string> = {
  done: "finished",
  error: "errored",
  stopped: "was stopped",
  "needs-input": "needs your decision",
  "rate-limited": "hit a usage limit",
};

/** Default transport: POST JSON with a short timeout so a dead endpoint can't hang a run. */
const fetchPost: PostFn = async (url, jsonBody) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: jsonBody,
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
};

/** Does this webhook subscribe to `event`? Empty/undefined `events` = all of them. */
export function subscribes(w: WebhookConfig, event: WebhookEvent): boolean {
  if (w.enabled === false) return false;
  if (!w.events || w.events.length === 0) return true;
  return w.events.includes(event);
}

/** One-line human message for an event, e.g. `✅ "fix login" finished — 12 turns, 8m`. */
export function messageFor(event: WebhookEvent, ctx: NotifyContext): string {
  const label = ctx.label.trim() || ctx.id.slice(0, 8);
  const head = `${EMOJI[event]} "${label}" ${VERB[event]}`;
  const stats = `${ctx.turns} turn${ctx.turns === 1 ? "" : "s"}, ${Math.round(ctx.elapsedMin)}m`;
  const tail = ctx.detail ? ` — ${ctx.detail}` : "";
  return `${head} (${stats})${tail}`;
}

/** Shape the request body for a given webhook format. */
export function bodyFor(format: WebhookConfig["format"], payload: NotifyPayload): string {
  switch (format) {
    case "slack":
      // Slack Incoming Webhooks read `text`.
      return JSON.stringify({ text: payload.message });
    case "discord":
      // Discord webhooks read `content`.
      return JSON.stringify({ content: payload.message });
    default:
      return JSON.stringify(payload);
  }
}

/**
 * Dispatches webhooks for orchestrator events. Reads the live webhook list lazily
 * (via a getter) so runtime edits take effect immediately, with no restart.
 */
export class Notifier {
  constructor(
    private readonly getWebhooks: () => WebhookConfig[] | undefined,
    private readonly post: PostFn = fetchPost,
    private readonly log: (msg: string) => void = (m) => console.error(m),
    /** Live quiet-hours config (read lazily so runtime edits apply at once). */
    private readonly getQuietHours: () => QuietHours | undefined = () => undefined,
    /** Injectable clock (tests pass a fixed time). */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when at least one enabled webhook exists (skip work otherwise). */
  get active(): boolean {
    return (this.getWebhooks() ?? []).some((w) => w.enabled !== false);
  }

  /**
   * Deliver `event` to every subscribed webhook. Non-blocking by design: failures
   * are logged, never thrown. Returns how many deliveries were attempted (handy
   * for tests / a "fired N webhooks" log line).
   */
  async fire(event: WebhookEvent, ctx: NotifyContext): Promise<number> {
    // Quiet hours silence outbound notifications (errors may still page if the
    // operator opted in via allowUrgent). Operational automations are unaffected —
    // this only gates the human-facing notification, not fleet actions.
    if (suppresses(this.getQuietHours(), event, this.now())) {
      this.log(`🔕 quiet hours — suppressed ${event} notification for "${ctx.label || ctx.id}"`);
      return 0;
    }
    const hooks = (this.getWebhooks() ?? []).filter((w) => subscribes(w, event));
    if (hooks.length === 0) return 0;
    const payload: NotifyPayload = {
      event,
      message: messageFor(event, ctx),
      session: {
        id: ctx.id,
        label: ctx.label,
        cwd: ctx.cwd,
        goal: ctx.goal,
        status: ctx.status,
        turns: ctx.turns,
        elapsedMin: ctx.elapsedMin,
      },
      detail: ctx.detail,
      timestamp: Date.now(),
    };
    await Promise.all(
      hooks.map(async (w) => {
        const r = await this.post(w.url, bodyFor(w.format, payload)).catch(
          (e): DeliveryResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        if (!r.ok) this.log(`⚠ webhook "${w.name}" (${event}) failed: ${r.error ?? "unknown error"}`);
      }),
    );
    return hooks.length;
  }

  /** Send a sample payload to one webhook so the operator can verify it works. */
  async test(w: WebhookConfig): Promise<DeliveryResult> {
    const ctx: NotifyContext = {
      id: w.id,
      label: "Test notification",
      cwd: "",
      goal: "verifying this webhook",
      status: "test",
      turns: 0,
      elapsedMin: 0,
      detail: "this is a test from your AGI orchestrator",
    };
    const payload: NotifyPayload = {
      event: "done",
      message: `🔔 Test notification from your AGI orchestrator — "${w.name}" is wired up correctly.`,
      session: { id: w.id, label: ctx.label, cwd: "", goal: ctx.goal, status: "test", turns: 0, elapsedMin: 0 },
      detail: ctx.detail,
      timestamp: Date.now(),
    };
    return this.post(w.url, bodyFor(w.format, payload));
  }
}

export { ALL_EVENTS };
