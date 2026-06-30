/**
 * Client-only UI state that doesn't belong to the backend snapshot: which session
 * is focused, which modal is open, and the transient toast queue. All reactive
 * via Svelte runes so any component can read/mutate it.
 */
import type { SessionView, SessionTemplate } from "./types";

export type Modal =
  | { kind: "new"; template?: SessionTemplate }
  | { kind: "edit"; session: SessionView }
  | { kind: "adopt" }
  | { kind: "adopt-form"; cwd: string; resumeId: string }
  | { kind: "history"; sessionId: string }
  | { kind: "settings" }
  | { kind: "attach" }
  | { kind: "learn" }
  | { kind: "templates" }
  | { kind: "continue"; session: SessionView };

interface Toast {
  id: number;
  message: string;
}

const FLEET_KEY = "agi.fleetCollapsed";
const readFleetCollapsed = (): boolean => {
  try {
    return localStorage.getItem(FLEET_KEY) === "1";
  } catch {
    return false;
  }
};

class UiState {
  focusId = $state<string | null>(null);
  modal = $state<Modal | null>(null);
  toasts = $state<Toast[]>([]);
  /** Left fleet panel collapsed to the status-dot rail (persisted). */
  fleetCollapsed = $state<boolean>(readFleetCollapsed());

  #seq = 0;

  openModal(m: Modal): void {
    this.modal = m;
  }
  closeModal(): void {
    this.modal = null;
  }

  toggleFleet(): void {
    this.fleetCollapsed = !this.fleetCollapsed;
    try {
      localStorage.setItem(FLEET_KEY, this.fleetCollapsed ? "1" : "0");
    } catch {
      /* private mode / storage disabled — fine, just won't persist */
    }
  }

  toast(message: string): void {
    const id = ++this.#seq;
    this.toasts = [...this.toasts, { id, message }];
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    }, 4000);
  }
}

export const ui = new UiState();
