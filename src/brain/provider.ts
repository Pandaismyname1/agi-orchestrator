/**
 * Local LLM provider — talks to LM Studio or Ollama via their OpenAI-compatible
 * /chat/completions endpoint. Both are supported by just pointing baseUrl at the
 * right port; no provider-specific code needed.
 *
 *   LM Studio: http://localhost:1234/v1
 *   Ollama:    http://localhost:11434/v1
 */
import type { ProviderConfig } from "../types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Retry tuning for transient brain failures. */
export interface RetryOptions {
  /** Extra attempts after the first (default 3). */
  retries?: number;
  /** Base backoff in ms; grows exponentially (default 400). */
  baseMs?: number;
}

/**
 * Is this error worth retrying? True for connection-level failures (model server
 * briefly down / restarting / model still loading) and 5xx/429 responses; false
 * for 4xx (a real client error that won't fix itself on retry).
 */
export function isTransientError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  // Our chat() throws `local LLM <status>: …` for non-OK responses.
  if (/local llm (5\d\d|429|503|502|500)\b/.test(msg)) return true;
  // Undici/Node connection-level failures + abort/timeout.
  return /fetch failed|econnrefused|econnreset|etimedout|enotfound|socket hang up|network|aborted|timeout|terminated|connect/.test(
    msg,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff. Non-transient
 * errors throw immediately. `sleepFn` is injectable so tests run without delay.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  const retries = opts?.retries ?? 3;
  const baseMs = opts?.baseMs ?? 400;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !isTransientError(e)) throw e;
      await sleepFn(baseMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

export class LocalLLM {
  constructor(
    private readonly cfg: ProviderConfig,
    /** Transient-failure retry policy (defaults applied in retry()). */
    private readonly retryOpts?: RetryOptions,
  ) {}

  /** True if the provider endpoint is reachable and the configured model is listed. */
  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.cfg.apiKey ?? "local"}` },
      });
      if (!res.ok) return { ok: false, detail: `GET /models -> ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const ids = (body.data ?? []).map((m) => m.id);
      const has = ids.includes(this.cfg.model);
      return {
        ok: has,
        detail: has
          ? `model "${this.cfg.model}" available`
          : `model "${this.cfg.model}" NOT in [${ids.join(", ") || "none"}]`,
      };
    } catch (e) {
      return { ok: false, detail: `cannot reach ${this.cfg.baseUrl}: ${(e as Error).message}` };
    }
  }

  /**
   * Single completion. Returns the assistant message content. Transient failures
   * (server briefly down/restarting, model still loading, 5xx/429) are retried
   * with backoff so a momentary blip doesn't kill a long unattended run.
   */
  async chat(messages: ChatMessage[]): Promise<string> {
    return retry(async () => {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey ?? "local"}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: this.cfg.temperature ?? 0.3,
          messages,
          stream: false,
        }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`local LLM ${res.status}: ${txt.slice(0, 300)}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return body.choices?.[0]?.message?.content ?? "";
    }, this.retryOpts);
  }
}
