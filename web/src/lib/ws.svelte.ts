/**
 * Live connection to the dashboard backend. Holds the latest snapshot as Svelte
 * reactive state ($state) and exposes a typed send(). Auto-reconnects on close.
 *
 * Consumers read `wsStore.snapshot` / `wsStore.connected` and call `wsStore.send(...)`.
 */
import type { ClientMsg, Snapshot } from "./types";
import { auth } from "./auth.svelte";

class WsStore {
  snapshot = $state<Snapshot | null>(null);
  connected = $state(false);
  /** Last transport/server error surfaced for the UI to toast. */
  lastError = $state<string | null>(null);

  #ws: WebSocket | null = null;
  #onError: ((msg: string) => void) | null = null;
  #retries = 0;
  #stopped = false;

  /** Register a callback for server-sent {type:"error"} messages (e.g. toast). */
  onError(cb: (msg: string) => void): void {
    this.#onError = cb;
  }

  connect(): void {
    // Design/demo mode: `?mock` paints a fixed snapshot and skips the socket.
    if (new URLSearchParams(location.search).has("mock")) {
      this.connected = true;
      void import("./mock").then((m) => (this.snapshot = m.MOCK));
      return;
    }
    // Idempotent: skip if a socket is already live (avoids duplicate connections
    // when the auth effect re-runs); reopen after a stale-token stop + re-login.
    if (this.#ws && !this.#stopped) return;
    this.#stopped = false;
    this.#retries = 0;
    this.#open();
  }

  #open(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // Browsers can't set headers on a WS upgrade, so the dispatch token rides in
    // the query string (the server reads ?token= for the upgrade gate).
    const q = auth.tokenParam();
    const ws = new WebSocket(`${proto}://${location.host}/ws${q ? `?${q}` : ""}`);
    this.#ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.#retries = 0;
    };
    ws.onmessage = (ev) => {
      let msg: { type?: string; message?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "error") {
        this.lastError = msg.message ?? "unknown error";
        this.#onError?.(this.lastError);
        return;
      }
      if (msg.type === "snapshot") {
        this.snapshot = msg as unknown as Snapshot;
      }
    };
    ws.onclose = () => {
      this.connected = false;
      this.#ws = null;
      if (this.#stopped) return;
      this.#retries++;
      // After a few quick failures the token may be stale (rotated/revoked). Browsers
      // can't read the WS close status, so probe /api/whoami to tell apart "token bad"
      // (→ stop, drop to the login gate) from "server briefly down" (→ keep retrying).
      // This also stops a stale token from hammering the server's brute-force guard.
      if (this.#retries >= 3) {
        void auth.recheck().then((verdict) => {
          if (this.#stopped) return;
          if (verdict === "unauthorized") {
            this.#stopped = true; // the login gate takes over
            return;
          }
          this.#schedule();
        });
        return;
      }
      this.#schedule();
    };
    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
  }

  /** Reconnect with capped exponential backoff (1, 2, 4, 8, 15s…). */
  #schedule(): void {
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.#retries, 4));
    setTimeout(() => {
      if (!this.#stopped && auth.status === "authed") this.#open();
    }, delay);
  }

  send(msg: ClientMsg): void {
    const ws = this.#ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

export const wsStore = new WsStore();
