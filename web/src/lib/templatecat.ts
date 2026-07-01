/**
 * Template category grouping/filtering — pure, DOM-free so it's unit-testable.
 *
 * A template's optional `category` groups it in the Templates modal. These helpers
 * derive the distinct category list (for the filter dropdown + form datalist),
 * filter by a selected category, and group a list under category headers.
 * Templates with no category fall into a trailing "Uncategorized" bucket.
 */

/** Label for templates that have no category set. */
export const UNCATEGORIZED = "Uncategorized";

/** The slice these helpers read. SessionTemplate structurally satisfies it. */
export interface Categorized {
  category?: string;
}

/** Trim a category to its canonical form ("" when unset/blank). */
export function normalizeCategory(c: string | undefined): string {
  return (c ?? "").trim();
}

/**
 * Distinct non-empty categories, sorted case-insensitively. Drives the filter
 * dropdown and the form's datalist so picking an existing category is one click.
 */
export function distinctCategories<T extends Categorized>(items: T[]): string[] {
  const set = new Set<string>();
  for (const t of items) {
    const c = normalizeCategory(t.category);
    if (c) set.add(c);
  }
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** True when at least one item has no category (→ show the "Uncategorized" filter option). */
export function hasUncategorized<T extends Categorized>(items: T[]): boolean {
  return items.some((t) => !normalizeCategory(t.category));
}

/**
 * Filter by a selected category. A null/empty selection returns everything;
 * `UNCATEGORIZED` returns only the un-categorized items; otherwise an exact match.
 */
export function filterByCategory<T extends Categorized>(items: T[], category: string | null): T[] {
  if (!category) return items;
  if (category === UNCATEGORIZED) return items.filter((t) => !normalizeCategory(t.category));
  return items.filter((t) => normalizeCategory(t.category) === category);
}

/** A category and the items under it. */
export interface CategoryGroup<T> {
  category: string;
  items: T[];
}

/**
 * Group items under category headers: named categories first (sorted, preserving
 * each item's original order within a group), then an "Uncategorized" group last
 * if any item lacks a category. Never emits an empty group.
 */
export function groupByCategory<T extends Categorized>(items: T[]): CategoryGroup<T>[] {
  const groups: CategoryGroup<T>[] = [];
  for (const c of distinctCategories(items)) {
    groups.push({ category: c, items: items.filter((t) => normalizeCategory(t.category) === c) });
  }
  const uncat = items.filter((t) => !normalizeCategory(t.category));
  if (uncat.length) groups.push({ category: UNCATEGORIZED, items: uncat });
  return groups;
}
