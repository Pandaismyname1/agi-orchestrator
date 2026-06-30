/**
 * Deterministic tests for the keyboard-shortcut cheatsheet (web/src/lib/shortcuts.ts).
 * Validates the catalog shape, the clipboard formatter, and — crucially — that
 * every key keynav.ts actually handles is documented (so a shortcut can't ship
 * undiscoverable). Pure logic, no DOM.
 */
import { SHORTCUT_GROUPS, formatShortcutsText, type ShortcutGroup } from "../web/src/lib/shortcuts.js";
import { planKey } from "../web/src/lib/keynav.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── catalog shape ────────────────────────────────────────────────────────────────
check("has groups", SHORTCUT_GROUPS.length >= 3);
check(
  "every item has >=1 key and a description",
  SHORTCUT_GROUPS.every((g) => g.title.length > 0 && g.items.length > 0 && g.items.every((s) => s.keys.length >= 1 && s.desc.trim().length > 0)),
);
check(
  "descriptions are unique within each group (safe #each key)",
  SHORTCUT_GROUPS.every((g) => new Set(g.items.map((s) => s.desc)).size === g.items.length),
);
check("group titles are unique", new Set(SHORTCUT_GROUPS.map((g) => g.title)).size === SHORTCUT_GROUPS.length);

// ── formatter ────────────────────────────────────────────────────────────────────
const text = formatShortcutsText();
check("text has a heading", text.startsWith("AGI orchestrator — keyboard shortcuts"));
check("text ends with a single newline", text.endsWith("\n") && !text.endsWith("\n\n"));
check("text lists every group title", SHORTCUT_GROUPS.every((g) => text.includes(g.title)));
check("text includes a known row", text.includes("Focus the next session"));
check(
  "descriptions are column-aligned (two-space gutter present)",
  text.split("\n").some((l) => /^ {2}\S.* {2}\S/.test(l)),
);
// formatter is pure over its argument
const custom: ShortcutGroup[] = [{ title: "X", items: [{ keys: ["a"], desc: "do a" }] }];
check("formats a custom group list", formatShortcutsText(custom).includes("X") && formatShortcutsText(custom).includes("a") && formatShortcutsText(custom).includes("do a"));

// ── discoverability: every keynav action key is documented ────────────────────────
// The single-key actions keynav.ts implements (Arrow/Home/End variants aside).
const KEYNAV_KEYS = ["j", "k", "g", "G", "s", "x", "o", "n", "/", "?", "Enter"];
const documentedKeys = new Set(SHORTCUT_GROUPS.flatMap((g) => g.items.flatMap((s) => s.keys)));
for (const k of KEYNAV_KEYS) {
  check(`key "${k}" is documented`, documentedKeys.has(k));
}

// ── the new keys actually wire through keynav ──────────────────────────────────────
const list = [{ id: "a", status: "idle" }];
check("? → help intent", planKey({ key: "?" }, { list, focusId: "a" }).type === "help");
check("/ still → search (not help)", planKey({ key: "/" }, { list, focusId: "a" }).type === "search");
check("? ignored with a modifier", planKey({ key: "?", ctrlKey: true }, { list, focusId: "a" }).type === "none");

console.log(`\n[shortcuts] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
