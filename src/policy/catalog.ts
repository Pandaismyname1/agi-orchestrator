/**
 * Starter template catalog — the "agent marketplace" foundation.
 *
 * A fresh install has no templates, so the New Session wizard starts blank. This
 * is a small, curated library of ready-to-run agent recipes the operator can
 * install with one click (they become normal, editable templates). Each carries
 * a stable `catalogId` so we can tell which are already installed and keep the
 * "install" idempotent.
 *
 * Pure data + helpers — no I/O, fully testable.
 */
import type { SessionTemplate } from "../types.js";

/** A built-in template recipe (shape of a SessionTemplate minus the persisted ids/timestamps). */
export interface CatalogTemplate {
  /** Stable identifier for this catalog entry (never changes across versions). */
  catalogId: string;
  name: string;
  description: string;
  goal: string;
  doneCriteria: string;
  permissionMode: NonNullable<SessionTemplate["permissionMode"]>;
  autonomy: NonNullable<SessionTemplate["autonomy"]>;
  startMode: NonNullable<SessionTemplate["startMode"]>;
}

/** A catalog entry plus whether the operator has already installed it. */
export type CatalogEntry = CatalogTemplate & { installed: boolean };

export const STARTER_TEMPLATES: CatalogTemplate[] = [
  {
    catalogId: "bugfix-sprint",
    name: "Bug-fix sprint",
    description: "Triage and fix open bugs until the test suite is green.",
    goal: "Find and fix the failing tests and open bugs in this project. Work through them one at a time, smallest blast radius first.",
    doneCriteria: "The full test suite passes, no known regressions remain, and each fix is a focused, well-described change.",
    permissionMode: "acceptEdits",
    autonomy: "balanced",
    startMode: "autopilot",
  },
  {
    catalogId: "test-coverage",
    name: "Test-coverage push",
    description: "Raise automated test coverage on under-tested code.",
    goal: "Add meaningful unit/integration tests for the least-covered, highest-risk modules. Prefer behavior-level tests over trivial ones; do not change production behavior.",
    doneCriteria: "New tests pass, cover the previously untested critical paths, and the suite stays green. No source behavior changed.",
    permissionMode: "acceptEdits",
    autonomy: "balanced",
    startMode: "autopilot",
  },
  {
    catalogId: "dep-upgrade",
    name: "Dependency upgrade",
    description: "Bump dependencies and fix any resulting breakage.",
    goal: "Upgrade outdated dependencies to current stable versions, then fix any build/test/type breakage the upgrades cause. Keep each upgrade reviewable.",
    doneCriteria: "Dependencies are upgraded, the project builds, type-checks, and all tests pass with no behavior regressions.",
    permissionMode: "acceptEdits",
    autonomy: "balanced",
    startMode: "autopilot",
  },
  {
    catalogId: "docs-polish",
    name: "Docs & README polish",
    description: "Improve the README and developer docs for clarity.",
    goal: "Improve the README and developer documentation: accurate setup steps, a clear feature overview, and runnable examples. Fix anything that's stale or wrong.",
    doneCriteria: "Docs are accurate against the current code, the setup steps work from scratch, and examples run as written.",
    permissionMode: "acceptEdits",
    autonomy: "balanced",
    startMode: "autopilot",
  },
  {
    catalogId: "security-audit",
    name: "Security audit",
    description: "Review the codebase for vulnerabilities and report findings.",
    goal: "Audit this codebase for security issues (injection, authz gaps, secret handling, unsafe deserialization, dependency CVEs). Report findings with severity and a suggested fix; do NOT make risky changes unattended.",
    doneCriteria: "A prioritized findings report is written to the repo, each item with location, impact, and a concrete remediation.",
    permissionMode: "default",
    autonomy: "cautious",
    startMode: "autopilot",
  },
  {
    catalogId: "refactor-cleanup",
    name: "Refactor & cleanup",
    description: "Reduce duplication and dead code without changing behavior.",
    goal: "Refactor for clarity: remove dead code and duplication, tighten names, and split overgrown files. Make NO behavior changes — pure structure.",
    doneCriteria: "Behavior is unchanged (tests still pass), duplication/dead code is reduced, and the diff is a clean structural refactor.",
    permissionMode: "acceptEdits",
    autonomy: "balanced",
    startMode: "autopilot",
  },
];

/** Annotate the catalog with which entries are already installed (by catalogId). */
export function catalogWithInstalled(installed: SessionTemplate[]): CatalogEntry[] {
  const have = new Set(installed.map((t) => t.catalogId).filter((x): x is string => !!x));
  return STARTER_TEMPLATES.map((t) => ({ ...t, installed: have.has(t.catalogId) }));
}

/** Look up a catalog entry by its stable id. */
export function findCatalogTemplate(catalogId: string): CatalogTemplate | undefined {
  return STARTER_TEMPLATES.find((t) => t.catalogId === catalogId);
}
