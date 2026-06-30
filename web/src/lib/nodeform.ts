/**
 * Quick "new session node" draft — pure normalization/validation for the
 * workflow builder's drop-to-create card, so it's unit-testable without the DOM.
 *
 * The builder lets you drop a "＋ Session" chip on the canvas and fill a tiny
 * inline form; this turns those raw fields into a clean `add` payload (or an
 * error message). The backend re-validates, but catching empties here gives
 * instant feedback and lets us assign a client id so the node can be positioned
 * at the drop point immediately.
 */

export type DraftMode = "manual" | "autopilot";

/** A normalized session-create payload (matches the `add` message's SessionInput subset). */
export interface SessionDraft {
  id?: string;
  cwd: string;
  goal: string;
  doneCriteria: string;
  startMode: DraftMode;
}

export interface DraftInput {
  id?: string;
  cwd?: string;
  goal?: string;
  doneCriteria?: string;
  mode?: DraftMode;
}

export type DraftResult = { ok: true; draft: SessionDraft } | { ok: false; error: string };

/** Default done-criteria when the operator leaves it blank (backend requires one). */
export const DEFAULT_DONE = "the goal is achieved";

/**
 * Validate + normalize a quick-create draft. Trims everything, requires a goal
 * and a cwd, defaults blank done-criteria, and preserves the (optional) client
 * id and mode. Returns either the clean draft or a single error message.
 */
export function buildSessionDraft(input: DraftInput): DraftResult {
  const cwd = (input.cwd ?? "").trim();
  const goal = (input.goal ?? "").trim();
  const doneCriteria = (input.doneCriteria ?? "").trim() || DEFAULT_DONE;
  if (!goal) return { ok: false, error: "a goal is required." };
  if (!cwd) return { ok: false, error: "a working directory is required." };
  const draft: SessionDraft = {
    cwd,
    goal,
    doneCriteria,
    startMode: input.mode === "manual" ? "manual" : "autopilot",
  };
  const id = (input.id ?? "").trim();
  if (id) draft.id = id;
  return { ok: true, draft };
}
