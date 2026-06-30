/**
 * Dispatch auth (client side). Holds the access token (persisted in localStorage)
 * and the gate state. On boot we probe `/api/whoami`: local users (and valid
 * tokens) pass straight through; remote users without a valid token see the Login
 * gate. The WebSocket and every REST call carry the token from here.
 */
const TOKEN_KEY = "agi.dispatchToken";
const isMock = (): boolean => new URLSearchParams(location.search).has("mock");

const readToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export type AuthStatus = "checking" | "authed" | "needsToken" | "disabledRemote" | "error";

class AuthStore {
  status = $state<AuthStatus>("checking");
  /** True when the server says this request came from loopback. */
  local = $state(false);
  error = $state<string | null>(null);
  token = $state<string | null>(readToken());

  /** `Authorization` header for fetches (empty when no token). */
  authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }
  /** `token=…` query fragment for the WebSocket URL (empty when no token). */
  tokenParam(): string {
    return this.token ? `token=${encodeURIComponent(this.token)}` : "";
  }

  async init(): Promise<void> {
    if (isMock()) {
      this.status = "authed";
      return;
    }
    await this.#probe();
  }

  /** User submitted a token in the Login gate. */
  async submit(token: string): Promise<void> {
    this.token = token.trim() || null;
    this.error = null;
    this.status = "checking";
    await this.#probe();
  }

  /** Clear the stored token and return to the gate. */
  signOut(): void {
    this.token = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    this.status = "needsToken";
    this.error = null;
  }

  /** Called when a live REST/WS call reports the token is no longer accepted. */
  invalidate(): void {
    if (this.status === "authed") {
      this.status = "needsToken";
      this.error = "Session expired — re-enter your access token.";
    }
  }

  /**
   * Re-probe auth without disturbing the app on a transient blip. Used by the WS
   * reconnect loop to tell "token went stale" (→ drop to the gate, stop hammering)
   * apart from "server briefly unreachable" (→ keep retrying, stay on the app).
   */
  async recheck(): Promise<"authed" | "unauthorized" | "unreachable"> {
    if (isMock()) return "authed";
    try {
      const res = await fetch("/api/whoami", { headers: this.authHeaders() });
      if (res.status === 429) return "unreachable"; // rate-limited; back off, don't gate
      const j = (await res.json()) as { ok?: boolean; local?: boolean; dispatchEnabled?: boolean };
      this.local = !!j.local;
      if (j.ok) {
        this.status = "authed";
        return "authed";
      }
      this.status = !j.dispatchEnabled && !j.local ? "disabledRemote" : "needsToken";
      if (this.token && this.status === "needsToken") {
        this.error = "Session expired — re-enter your access token.";
      }
      return "unauthorized";
    } catch {
      return "unreachable"; // transient — keep the app up and retry
    }
  }

  /** Probe /api/whoami; updates status. Returns true when authorized. */
  async #probe(): Promise<boolean> {
    try {
      const res = await fetch("/api/whoami", { headers: this.authHeaders() });
      if (res.status === 429) {
        this.status = "error";
        this.error = "Too many attempts — wait a minute, then retry.";
        return false;
      }
      const j = (await res.json()) as { ok?: boolean; local?: boolean; dispatchEnabled?: boolean };
      this.local = !!j.local;
      if (j.ok) {
        this.status = "authed";
        if (this.token) {
          try {
            localStorage.setItem(TOKEN_KEY, this.token);
          } catch {
            /* ignore */
          }
        }
        return true;
      }
      if (!j.dispatchEnabled && !j.local) {
        this.status = "disabledRemote";
        return false;
      }
      this.status = "needsToken";
      // A token was present but rejected (vs. a first-time prompt with no token).
      if (this.token) this.error = "That token didn't work — check it and try again.";
      return false;
    } catch {
      this.status = "error";
      this.error = "Can't reach the server. Retry when it's back.";
      return false;
    }
  }
}

export const auth = new AuthStore();
