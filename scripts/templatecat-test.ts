/**
 * Deterministic tests for template category grouping/filtering
 * (web/src/lib/templatecat.ts). Pure — no DOM. Covers normalization, distinct
 * list ordering, filtering (all / named / uncategorized), and grouping order.
 */
import {
  normalizeCategory,
  distinctCategories,
  hasUncategorized,
  filterByCategory,
  groupByCategory,
  UNCATEGORIZED,
} from "../web/src/lib/templatecat.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

interface T { id: string; category?: string }
const items: T[] = [
  { id: "a", category: "Audits" },
  { id: "b", category: "bug fixes" },
  { id: "c" }, // uncategorized
  { id: "d", category: "Audits" },
  { id: "e", category: "  " }, // blank → uncategorized
];

// ── normalizeCategory ─────────────────────────────────────────────────────────────
check("trims whitespace", normalizeCategory("  Audits  ") === "Audits");
check("blank → empty", normalizeCategory("   ") === "" && normalizeCategory(undefined) === "");

// ── distinctCategories ──────────────────────────────────────────────────────────────
check("distinct excludes empties, dedupes", JSON.stringify(distinctCategories(items)) === JSON.stringify(["Audits", "bug fixes"]));
check("distinct is case-insensitively sorted", JSON.stringify(distinctCategories([{ id: "1", category: "zebra" }, { id: "2", category: "Apple" }])) === JSON.stringify(["Apple", "zebra"]));
check("distinct on empty list → []", distinctCategories([]).length === 0);

// ── hasUncategorized ────────────────────────────────────────────────────────────────
check("detects an uncategorized item", hasUncategorized(items) === true);
check("false when all categorized", hasUncategorized([{ id: "x", category: "A" }]) === false);

// ── filterByCategory ────────────────────────────────────────────────────────────────
check("null/empty selection → all", filterByCategory(items, null).length === 5 && filterByCategory(items, "").length === 5);
check("named category exact match", filterByCategory(items, "Audits").map((t) => t.id).join(",") === "a,d");
check("UNCATEGORIZED returns blank+missing", filterByCategory(items, UNCATEGORIZED).map((t) => t.id).join(",") === "c,e");
check("unknown category → empty", filterByCategory(items, "nope").length === 0);

// ── groupByCategory ────────────────────────────────────────────────────────────────
const groups = groupByCategory(items);
check("groups: named (sorted) then Uncategorized last", groups.map((g) => g.category).join(",") === "Audits,bug fixes,Uncategorized");
check("group items preserve order within a category", groups[0]!.items.map((t) => t.id).join(",") === "a,d");
check("uncategorized group collects blank + missing", groups[2]!.items.map((t) => t.id).join(",") === "c,e");
check("no Uncategorized group when all categorized", groupByCategory([{ id: "x", category: "A" }]).length === 1);
check("empty input → no groups", groupByCategory([]).length === 0);
check("all-uncategorized → single Uncategorized group", (() => {
  const g = groupByCategory<T>([{ id: "1" }, { id: "2" }]);
  return g.length === 1 && g[0]!.category === UNCATEGORIZED && g[0]!.items.length === 2;
})());

console.log(`\n[templatecat] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
