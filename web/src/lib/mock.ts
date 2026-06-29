/**
 * Demo snapshot for design iteration + screenshots. Loaded only when the page is
 * opened with `?mock` (see ws.svelte.ts) — dynamically imported so it stays out of
 * the main bundle in normal use.
 */
import type { Snapshot, RunRow, RunDetail, Metrics } from "./types";

export const MOCK: Snapshot = {
  type: "snapshot",
  provider: { model: "qwen3.5:9b", baseUrl: "http://localhost:11434/v1", ok: true },
  budget: { turns: 142, maxTurns: 300, minutes: 88, maxMinutes: 240, exceeded: false },
  settings: {
    providerModel: "qwen3.5:9b",
    providerBaseUrl: "http://localhost:11434/v1",
    maxConcurrent: 2,
    budget: { maxTurns: 300, maxMinutes: 240 },
    defaults: { permissionMode: "acceptEdits", autonomy: "balanced" },
  },
  sessions: [
    {
      id: "refactor-db",
      cwd: "C:\\dev\\core",
      goal: "Migrate the data layer from raw SQL to the query builder.",
      doneCriteria: "all queries migrated, tests green",
      permissionMode: "default",
      autonomy: "cautious",
      mode: "autopilot",
      status: "needs-input",
      turns: 7,
      elapsedMin: 12.0,
      lastReply: "",
      lastDecision: "⚠ risky gate: rm -rf ./legacy",
      attention: {
        kind: "gate",
        question: "Claude wants to run: rm -rf ./legacy — delete the legacy SQL folder?",
        options: [
          { label: "Approve once", rationale: "folder is committed to git, recoverable" },
          { label: "Deny", rationale: "keep it for reference this run" },
        ],
      },
    },
    {
      id: "api-server",
      cwd: "C:\\dev\\api",
      goal: "Build the REST API with auth, rate limiting, and OpenAPI docs.",
      doneCriteria: "endpoints pass integration tests",
      permissionMode: "acceptEdits",
      autonomy: "balanced",
      mode: "autopilot",
      status: "running",
      turns: 23,
      elapsedMin: 41.2,
      lastReply: "",
      lastDecision: "continue → wire the /auth refresh-token endpoint and add a test",
      attention: null,
    },
    {
      id: "docs-site",
      cwd: "C:\\dev\\docs",
      goal: "Write and polish the documentation site with examples.",
      doneCriteria: "all pages drafted",
      permissionMode: "acceptEdits",
      autonomy: "autonomous",
      mode: "autopilot",
      status: "running",
      turns: 11,
      elapsedMin: 18.7,
      lastReply: "",
      lastDecision: "continue → add a quickstart code sample to the landing page",
      attention: null,
    },
    {
      id: "mobile-ui",
      cwd: "C:\\dev\\app",
      goal: "Implement the onboarding flow screens in React Native.",
      doneCriteria: "3 screens built",
      permissionMode: "default",
      autonomy: "balanced",
      mode: "manual",
      status: "manual",
      turns: 4,
      elapsedMin: 6.3,
      lastReply: "",
      lastDecision: "",
      attention: null,
    },
    {
      id: "data-pipeline",
      cwd: "C:\\dev\\etl",
      goal: "Build the nightly ETL job and add monitoring.",
      doneCriteria: "job runs end to end",
      permissionMode: "default",
      autonomy: "balanced",
      mode: "autopilot",
      status: "error",
      turns: 0,
      elapsedMin: 0,
      lastReply: "",
      lastDecision: "error: the local model became unreachable mid-run",
      error: "local model became unreachable (connection refused @ :11434)",
      attention: null,
    },
    {
      id: "landing-page",
      cwd: "C:\\dev\\www",
      goal: "Ship the marketing landing page and hook up analytics.",
      doneCriteria: "deployed to prod",
      permissionMode: "acceptEdits",
      autonomy: "balanced",
      mode: "autopilot",
      status: "done",
      turns: 31,
      elapsedMin: 52.9,
      lastReply: "",
      lastDecision: "stopped: goal met — landing page deployed",
      attention: null,
      canContinue: true,
    },
  ],
  focus: {
    id: "api-server",
    screen: [
      "> Added refresh-token rotation to src/auth/tokens.ts and a regression",
      "  test in tests/auth.spec.ts.",
      "",
      "● Running 14 tests…",
      "  ✓ issues a refresh token on login",
      "  ✓ rotates the token on refresh",
      "  ✓ rejects a reused token",
      "",
      "All tests passing. Ready for the next step.",
    ].join("\n"),
  },
};

/** Demo history/transcript data (api.ts serves these when `?mock`). */
export const MOCK_RUNS: RunRow[] = [
  { id: 7, status: "ended", turns: 3, elapsed_min: 41.2, stop_reason: "goal met — endpoints, docs, and tests complete" },
  { id: 5, status: "ended", turns: 2, elapsed_min: 12.4, stop_reason: "stopped by user" },
];

export const MOCK_RUN: RunDetail = {
  run: MOCK_RUNS[0],
  turns: [
    {
      n: 1,
      injected_prompt: "Build the REST API with auth, rate limiting, and OpenAPI docs.",
      assistant_text:
        "I'll scaffold the Express app, add the /auth routes, and set up a test harness. Starting with the project structure, a health endpoint, and the test runner config.",
    },
    {
      n: 2,
      injected_prompt: "Implement the login + refresh-token endpoints, with tests.",
      assistant_text:
        "Added refresh-token rotation in src/auth/tokens.ts and a regression test in tests/auth.spec.ts.\n\nRunning 14 tests…\n  ✓ issues a refresh token on login\n  ✓ rotates the token on refresh\n  ✓ rejects a reused token\nAll passing.",
    },
    {
      n: 3,
      injected_prompt: "Actually, do the OpenAPI docs first, before the rate limiting.",
      assistant_text:
        "Understood — generated the OpenAPI 3.1 spec at openapi.yaml covering every auth route with request/response examples, and wired Swagger UI at /docs.",
    },
  ],
  decisions: [
    {
      n: 1,
      action: "continue",
      reason: "Scaffold is in place; proceed to the core auth endpoints.",
      prompt: "Implement the login + refresh-token endpoints, with tests.",
    },
    {
      n: 2,
      action: "continue",
      reason: "Auth works and the tests pass; next add rate limiting.",
      prompt: "Add rate-limiting middleware and document it.",
    },
    {
      n: 3,
      action: "stop",
      reason: "Endpoints, docs, and tests are complete — done criteria met.",
      prompt: null,
    },
  ],
  events: [],
};

export const MOCK_METRICS: Metrics = {
  runs: 2,
  turns: 5,
  avgTurns: 2.5,
  interventionRate: 0.2,
  byStatus: { ended: 2 },
};
