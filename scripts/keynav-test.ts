/**
 * Deterministic tests for fleet keyboard navigation (web/src/lib/keynav.ts).
 * Pure logic, no Svelte/DOM — verifies the shortcut map, focus wrapping, the
 * start/stop guards, modifier passthrough, and the typing-target guard.
 */
import {
  planKey,
  focusIndex,
  isStartable,
  isStoppable,
  isTypingTarget,
  type NavSession,
  type NavState,
  type KeyEventLike,
} from "../web/src/lib/keynav.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const list: NavSession[] = [
  { id: "a", status: "running" },
  { id: "b", status: "idle" },
  { id: "c", status: "error" },
];
const st = (focusId: string | null): NavState => ({ list, focusId });
const key = (k: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({ key: k, ...mods });

// ── focusIndex ────────────────────────────────────────────────────────────────
check("focusIndex finds the focused id", focusIndex(st("b")) === 1);
check("focusIndex is -1 when none", focusIndex(st(null)) === -1);
check("focusIndex is -1 when id absent", focusIndex(st("zzz")) === -1);

// ── j / k navigation (wrapping) ─────────────────────────────────────────────────
check("j moves to next", JSON.stringify(planKey(key("j"), st("a"))) === JSON.stringify({ type: "focus", id: "b" }));
check("ArrowDown == j", planKey(key("ArrowDown"), st("a")).type === "focus");
check("j wraps last→first", (planKey(key("j"), st("c")) as any).id === "a");
check("j with no focus picks first", (planKey(key("j"), st(null)) as any).id === "a");
check("k moves to prev", (planKey(key("k"), st("b")) as any).id === "a");
check("k wraps first→last", (planKey(key("k"), st("a")) as any).id === "c");
check("k with no focus picks last", (planKey(key("k"), st(null)) as any).id === "c");

// ── g / G jump ───────────────────────────────────────────────────────────────────
check("g jumps to first", (planKey(key("g"), st("c")) as any).id === "a");
check("G jumps to last", (planKey(key("G"), st("a")) as any).id === "c");
check("Home == g", (planKey(key("Home"), st("c")) as any).id === "a");
check("End == G", (planKey(key("End"), st("a")) as any).id === "c");

// ── start / stop guards ────────────────────────────────────────────────────────
check("s starts an idle session", JSON.stringify(planKey(key("s"), st("b"))) === JSON.stringify({ type: "start", id: "b" }));
check("s on a running session is a no-op", planKey(key("s"), st("a")).type === "none");
check("x stops a running session", JSON.stringify(planKey(key("x"), st("a"))) === JSON.stringify({ type: "stop", id: "a" }));
check("x on an idle session is a no-op", planKey(key("x"), st("b")).type === "none");
check("s with no focus is a no-op", planKey(key("s"), st(null)).type === "none");
check("isStartable / isStoppable agree with palette sets", isStartable("error") && isStoppable("needs-input") && !isStartable("running"));

// ── history / new / search ───────────────────────────────────────────────────────
check("Enter opens focused history", JSON.stringify(planKey(key("Enter"), st("c"))) === JSON.stringify({ type: "history", id: "c" }));
check("o == Enter", planKey(key("o"), st("c")).type === "history");
check("Enter with no focus is a no-op", planKey(key("Enter"), st(null)).type === "none");
check("n requests a new session", planKey(key("n"), st("a")).type === "new");
check("/ jumps to search", planKey(key("/"), st("a")).type === "search");
check("? opens help", planKey(key("?"), st("a")).type === "help");
check("shift+/ opens help (alt encoding of ?)", planKey(key("/", { shiftKey: true }), st("a")).type === "help");
check("plain / still searches (no shift)", planKey(key("/"), st("a")).type === "search");

// ── modifier passthrough (don't steal ⌘K etc.) ──────────────────────────────────
check("ctrl+j is ignored", planKey(key("j", { ctrlKey: true }), st("a")).type === "none");
check("meta+k is ignored", planKey(key("k", { metaKey: true }), st("a")).type === "none");
check("alt+s is ignored", planKey(key("s", { altKey: true }), st("b")).type === "none");

// ── unmapped keys ────────────────────────────────────────────────────────────────
check("unmapped key is a no-op", planKey(key("z"), st("a")).type === "none");

// ── typing-target guard ──────────────────────────────────────────────────────────
check("INPUT is a typing target", isTypingTarget("input", false));
check("TEXTAREA is a typing target", isTypingTarget("TEXTAREA", false));
check("SELECT is a typing target", isTypingTarget("select", false));
check("contenteditable is a typing target", isTypingTarget("div", true));
check("DIV is not a typing target", !isTypingTarget("div", false));
check("undefined tag is not a typing target", !isTypingTarget(undefined, false));

// ── empty list ───────────────────────────────────────────────────────────────────
const empty: NavState = { list: [], focusId: null };
check("j on empty list is a no-op", planKey(key("j"), empty).type === "none");
check("g on empty list is a no-op", planKey(key("g"), empty).type === "none");

console.log(`\n[keynav] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
