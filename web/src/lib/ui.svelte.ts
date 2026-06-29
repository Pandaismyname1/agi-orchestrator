/**
 * Client-only UI state that doesn't belong to the backend snapshot: which session
 * is focused, which modal is open, and the transient toast queue. All reactive
 * via Svelte runes so any component can read/mutate it.
 */
import type { SessionView } from "./types";

export type Modal =
  | { kind: "new" }
  | { kind: "edit"; session: SessionView }
  | { kind: "adopt" }
  | { kind: "adopt-form"; cwd: string; resumeId: string }
  | { kind: "history"; sessionId: string }
  | { kind: "settings" }
  | { kind: "attach" }
  | { kind: "learn" }
  | { kind: "continue"; session: SessionView };

interface Toast {
  id: number;
  message: string;
}

class UiState {
  focusId = $state<string | null>(null);
  modal = $state<Modal | null>(null);
  toasts = $state<Toast[]>([]);

  #seq = 0;

  openModal(m: Modal): void {
    this.modal = m;
  }
  closeModal(): void {
    this.modal = null;
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
