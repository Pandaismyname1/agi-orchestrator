/**
 * Live connection to the dashboard backend. Holds the latest snapshot as Svelte
 * reactive state ($state) and exposes a typed send(). Auto-reconnects on close.
 *
 * Consumers read `wsStore.snapshot` / `wsStore.connected` and call `wsStore.send(...)`.
 */
import type { ClientMsg, Snapshot } from "./types";

class WsStore {
  snapshot = $state<Snapshot | null>(null);
  connected = $state(false);
  /** Last transport/server error surfaced for the UI to toast. */
  lastError = $state<string | null>(null);

  #ws: WebSocket | null = null;
  #onError: ((msg: string) => void) | null = null;

  /** Register a callback for server-sent {type:"error"} messages (e.g. toast). */
  onError(cb: (msg: string) => void): void {
    this.#onError = cb;
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.#ws = ws;

    ws.onopen = () => {
      this.connected = true;
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
      setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
  }

  send(msg: ClientMsg): void {
    const ws = this.#ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

export const wsStore = new WsStore();
