/**
 * Fleet keyboard navigation — pure decision logic, no DOM.
 *
 * Given a keydown descriptor and the current fleet state (the *visible* ordered
 * list plus which session is focused), `planKey` returns a single intent the
 * caller executes (move focus, start/stop a session, open the search box, etc.).
 * Keeping it pure makes the shortcut map exhaustively testable without a browser.
 *
 * Shortcuts (no modifier held — modifier combos belong to the ⌘K palette):
 *   j / ArrowDown   move focus to the next session (wraps; first if none)
 *   k / ArrowUp     move focus to the previous session (wraps; last if none)
 *   g / Home        focus the first session
 *   G / End         focus the last session
 *   s               start the focused session (if it can be started)
 *   x               stop the focused session (if it can be stopped)
 *   Enter / o       open the focused session's history
 *   n               new session
 *   /               jump to the fleet search box
 *   ?               show the keyboard-shortcuts cheatsheet
 */

export interface NavSession {
  id: string;
  status: string;
}

export interface NavState {
  /** The visible, ordered session list (already filtered + sorted). */
  list: NavSession[];
  /** Currently focused session id, or null. */
  focusId: string | null;
}

export type NavIntent =
  | { type: "none" }
  | { type: "focus"; id: string }
  | { type: "start"; id: string }
  | { type: "stop"; id: string }
  | { type: "history"; id: string }
  | { type: "new" }
  | { type: "search" }
  | { type: "help" };

export interface KeyEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

// Mirrors the start/stop affordances the command palette and bulk actions use,
// so a key shortcut never offers an action the rest of the UI wouldn't.
const STARTABLE = new Set(["idle", "stopped", "done", "error", "blocked"]);
const STOPPABLE = new Set(["running", "manual", "needs-input", "queued", "rate-limited"]);

export const isStartable = (status: string): boolean => STARTABLE.has(status);
export const isStoppable = (status: string): boolean => STOPPABLE.has(status);

/** Index of the focused session in the visible list, or -1 if none/absent. */
export function focusIndex(state: NavState): number {
  if (!state.focusId) return -1;
  return state.list.findIndex((s) => s.id === state.focusId);
}

/** The session the focus currently points at, or undefined. */
function focused(state: NavState): NavSession | undefined {
  const i = focusIndex(state);
  return i >= 0 ? state.list[i] : undefined;
}

/**
 * True when a keydown should be ignored because the user is typing into a field
 * (or a modal/palette has the stage). The caller passes the active element's tag
 * and contenteditable flag; this keeps the DOM peek out of the pure planner.
 */
export function isTypingTarget(tagName: string | undefined, isContentEditable: boolean): boolean {
  if (isContentEditable) return true;
  const t = (tagName ?? "").toUpperCase();
  return t === "INPUT" || t === "TEXTAREA" || t === "SELECT";
}

/** Map a keydown + fleet state to a single intent. Returns `none` to ignore. */
export function planKey(e: KeyEventLike, state: NavState): NavIntent {
  // Modifier combos are reserved (⌘K, browser shortcuts) — never claim them.
  if (e.ctrlKey || e.metaKey || e.altKey) return { type: "none" };

  const list = state.list;
  const n = list.length;
  const i = focusIndex(state);

  switch (e.key) {
    case "j":
    case "ArrowDown": {
      if (!n) return { type: "none" };
      const next = i < 0 ? 0 : (i + 1) % n;
      return { type: "focus", id: list[next]!.id };
    }
    case "k":
    case "ArrowUp": {
      if (!n) return { type: "none" };
      const prev = i < 0 ? n - 1 : (i - 1 + n) % n;
      return { type: "focus", id: list[prev]!.id };
    }
    case "g":
    case "Home": {
      if (!n) return { type: "none" };
      return { type: "focus", id: list[0]!.id };
    }
    case "G":
    case "End": {
      if (!n) return { type: "none" };
      return { type: "focus", id: list[n - 1]!.id };
    }
    case "s": {
      const f = focused(state);
      return f && isStartable(f.status) ? { type: "start", id: f.id } : { type: "none" };
    }
    case "x": {
      const f = focused(state);
      return f && isStoppable(f.status) ? { type: "stop", id: f.id } : { type: "none" };
    }
    case "o":
    case "Enter": {
      const f = focused(state);
      return f ? { type: "history", id: f.id } : { type: "none" };
    }
    case "n":
      return { type: "new" };
    case "/":
      // Shift+/ is "?" on most layouts; some sources report key "/" + shift.
      return e.shiftKey ? { type: "help" } : { type: "search" };
    case "?":
      return { type: "help" };
    default:
      return { type: "none" };
  }
}
