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

export class LocalLLM {
  constructor(private readonly cfg: ProviderConfig) {}

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

  /** Single completion. Returns the assistant message content. */
  async chat(messages: ChatMessage[]): Promise<string> {
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
  }
}
