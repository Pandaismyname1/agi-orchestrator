/**
 * The canonical keyboard-shortcut catalog — the single source of truth for the
 * cheatsheet modal AND the copy-to-clipboard export. Kept as plain data (no DOM)
 * so it can be rendered, formatted, and unit-tested without a browser. It mirrors
 * what `keynav.ts` and the command palette actually do; the test cross-checks the
 * two so a new shortcut can't ship undocumented.
 */

export interface Shortcut {
  /** One or more equivalent keys for this action (e.g. ["j", "↓"]). */
  keys: string[];
  /** What the shortcut does. */
  desc: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Global",
    items: [
      { keys: ["⌘K", "Ctrl K"], desc: "Open the command palette" },
      { keys: ["?"], desc: "Show this keyboard-shortcuts cheatsheet" },
      { keys: ["Esc"], desc: "Close the palette, a modal, or this sheet" },
    ],
  },
  {
    title: "Fleet navigation",
    items: [
      { keys: ["j", "↓"], desc: "Focus the next session" },
      { keys: ["k", "↑"], desc: "Focus the previous session" },
      { keys: ["g", "Home"], desc: "Focus the first session" },
      { keys: ["G", "End"], desc: "Focus the last session" },
      { keys: ["/"], desc: "Jump to the fleet search box" },
    ],
  },
  {
    title: "Session actions",
    items: [
      { keys: ["s"], desc: "Start the focused session" },
      { keys: ["x"], desc: "Stop the focused session" },
      { keys: ["Enter", "o"], desc: "Open the focused session's history" },
      { keys: ["n"], desc: "Create a new session" },
    ],
  },
  {
    title: "Command palette",
    items: [
      { keys: ["↑", "↓"], desc: "Move through the results" },
      { keys: ["Enter"], desc: "Run the highlighted command" },
      { keys: ["Esc"], desc: "Close the palette" },
    ],
  },
];

/**
 * Plain-text rendering for the clipboard, e.g.
 *   Fleet navigation
 *     j / ↓          Focus the next session
 * Keys are joined with " / " and the description column is aligned.
 */
export function formatShortcutsText(groups: ShortcutGroup[] = SHORTCUT_GROUPS): string {
  const rendered = groups.map((g) => ({
    title: g.title,
    rows: g.items.map((s) => ({ keys: s.keys.join(" / "), desc: s.desc })),
  }));
  // Align descriptions to the widest key cell across the whole sheet.
  const width = Math.max(0, ...rendered.flatMap((g) => g.rows.map((r) => r.keys.length)));
  const lines: string[] = ["AGI orchestrator — keyboard shortcuts", ""];
  for (const g of rendered) {
    lines.push(g.title);
    for (const r of g.rows) lines.push(`  ${r.keys.padEnd(width)}  ${r.desc}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
