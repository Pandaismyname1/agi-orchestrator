/**
 * Demo snapshot for design iteration + screenshots. Loaded only when the page is
 * opened with `?mock` (see ws.svelte.ts) — dynamically imported so it stays out of
 * the main bundle in normal use.
 */
import type {
  Snapshot,
  RunRow,
  RunDetail,
  Metrics,
  LearningSummary,
  DraftProposal,
  OperatorProfile,
  DiscoveredSession,
} from "./types";

/** Demo discovery list (CLI + Desktop) for the Adopt browser under `?mock`. */
export const MOCK_DISCOVER: DiscoveredSession[] = [
  {
    sessionId: "0ec58aba-ce87-4ecb-8517-76c9acb246d7",
    cwd: "C:\\Users\\panda\\Desktop\\AGI",
    projectCwd: "C:\\Users\\panda\\Desktop\\AGI",
    summary: "AGI Project Starter",
    title: "AGI Project Starter",
    turns: 0,
    lastActivity: Date.now() - 1000 * 60 * 20,
    source: "desktop",
    resumable: true,
  },
  {
    sessionId: "fa0cadfe-91cc-41fd-af5e-d0321f226cd5",
    cwd: "C:\\Users\\panda\\PhpstormProjects\\eve",
    projectCwd: "C:\\Users\\panda\\PhpstormProjects\\eve",
    summary: "Analyze database performance and optimization",
    title: "Analyze database performance and optimization",
    turns: 0,
    lastActivity: Date.now() - 1000 * 60 * 60 * 5,
    source: "desktop",
    resumable: true,
  },
  {
    sessionId: "1654fcb6-f1fc-499b-8348-8cb0e61f6478",
    cwd: "C:\\Users\\panda\\PhpstormProjects\\eve\\.claude\\worktrees\\dazzling-clarke",
    projectCwd: "C:\\Users\\panda\\PhpstormProjects\\eve",
    summary: "Initialize project setup",
    title: "Initialize project setup",
    turns: 0,
    lastActivity: Date.now() - 1000 * 60 * 60 * 24 * 9,
    source: "desktop",
    resumable: false,
  },
  {
    sessionId: "19b2afb5-06af-4fa1-b903-853bf5fd061d",
    cwd: "C:\\Users\\panda\\IdeaProjects\\Satisfactory",
    projectCwd: "C:\\Users\\panda\\IdeaProjects\\Satisfactory",
    summary: "Satisfactory MC mod",
    title: "Satisfactory MC mod",
    turns: 0,
    lastActivity: Date.now() - 1000 * 60 * 60 * 24 * 2,
    source: "desktop",
    resumable: true,
  },
  {
    sessionId: "7c2e1d40-9a8b-4c1d-bf21-1122aa334455",
    cwd: "C:\\dev\\scratch",
    summary: "Fix the failing CI lint step and push",
    turns: 14,
    lastActivity: Date.now() - 1000 * 60 * 60 * 3,
    source: "cli",
    resumable: true,
  },
];

/** Demo learning-loop data (api.ts serves these when `?mock`). */
export const MOCK_LEARNING: LearningSummary = {
  enabled: true,
  global: {
    scope: "global",
    label: "Global",
    activeVersion: 3,
    versions: 3,
    examples: 4,
    hasDraft: true,
    updatedAt: Date.now() - 1000 * 60 * 60 * 6,
  },
  projects: [
    {
      scope: "cwd:C:\\dev\\api",
      label: "api",
      activeVersion: 1,
      versions: 1,
      examples: 2,
      hasDraft: false,
      updatedAt: Date.now() - 1000 * 60 * 60 * 30,
    },
    {
      scope: "cwd:C:\\dev\\core",
      label: "core",
      activeVersion: null,
      versions: 0,
      examples: 0,
      hasDraft: false,
      updatedAt: null,
    },
  ],
};

export const MOCK_VERSIONS: OperatorProfile[] = [
  {
    schema: 1,
    scope: "global",
    version: 3,
    guidance:
      "Prefer continuing autonomously when tests pass and the change is reversible. Only escalate destructive or irreversible actions (deletes, force-push, schema drops). Keep momentum: when a step is done and the next is obvious from the goal, proceed without asking.",
    examples: [
      {
        situation: "Tests are green after a refactor and the next step is documented in the goal.",
        instruction: "Continue to the next step without escalating.",
      },
      {
        situation: "Claude proposes `rm -rf` on an uncommitted directory.",
        instruction: "Escalate — this is irreversible and not in git.",
      },
    ],
    createdAt: Date.now() - 1000 * 60 * 60 * 30,
    meta: { fromPastSessions: 12, fromLiveCorrections: 5, model: "qwen3.5:9b" },
  },
  {
    schema: 1,
    scope: "global",
    version: 2,
    guidance:
      "Continue when the build is green; escalate on anything touching production data or credentials.",
    examples: [
      {
        situation: "A migration would alter a production table.",
        instruction: "Escalate before running.",
      },
    ],
    createdAt: Date.now() - 1000 * 60 * 60 * 72,
    meta: { fromPastSessions: 8, fromLiveCorrections: 2, model: "qwen3.5:9b" },
  },
  {
    schema: 1,
    scope: "global",
    version: 1,
    guidance: "Escalate whenever uncertain.",
    examples: [],
    createdAt: Date.now() - 1000 * 60 * 60 * 120,
    meta: { fromPastSessions: 3, fromLiveCorrections: 0, model: "qwen3.5:9b" },
  },
];

export const MOCK_DRAFT: DraftProposal = {
  schema: 1,
  scope: "global",
  baseVersion: 3,
  createdAt: Date.now() - 1000 * 60 * 30,
  draft: {
    schema: 1,
    scope: "global",
    guidance:
      "Prefer continuing autonomously when tests pass and the change is reversible. Only escalate destructive or irreversible actions (deletes, force-push, schema drops). When the user has corrected the same kind of decision twice, bake that correction in and stop asking. Keep momentum: when a step is done and the next is obvious, proceed.",
    examples: [
      {
        situation: "Tests are green after a refactor and the next step is documented in the goal.",
        instruction: "Continue to the next step without escalating.",
      },
      {
        situation: "Claude proposes `rm -rf` on an uncommitted directory.",
        instruction: "Escalate — this is irreversible and not in git.",
      },
      {
        situation: "The user has twice approved running the test suite without asking.",
        instruction: "Run the test suite directly; do not escalate.",
      },
    ],
    meta: {
      fromPastSessions: 14,
      fromLiveCorrections: 7,
      model: "qwen3.5:9b",
      note: "Folds in two recurring live corrections about test runs.",
    },
  },
  eval: {
    schema: 1,
    total: 24,
    baselineMatch: 17,
    profileMatch: 21,
    matchRate: 21 / 24,
    delta: 4,
    ranAt: Date.now() - 1000 * 60 * 25,
    note: "Replayed against 24 past decisions.",
  },
};

export const MOCK: Snapshot = {
  type: "snapshot",
  provider: { model: "qwen3.5:9b", baseUrl: "http://localhost:11434/v1", ok: true },
  budget: { turns: 142, maxTurns: 300, minutes: 88, maxMinutes: 240, exceeded: false },
  usage: {
    capturedAt: Date.now(),
    session: { pct: 62, resetText: "10:49am", resetAt: Date.now() + 2.3 * 3600_000 },
    weeklyAll: { pct: 88, resetText: "Sat 10:59pm", resetAt: Date.now() + 52 * 3600_000 },
    weeklySonnet: { pct: 14, resetText: "Sat 10:59pm", resetAt: Date.now() + 52 * 3600_000 },
  },
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
    {
      id: "deploy-prod",
      cwd: "C:\\dev\\api",
      goal: "Deploy the API + landing page to production once both are ready.",
      doneCriteria: "live on prod, smoke tests pass",
      permissionMode: "default",
      autonomy: "cautious",
      mode: "autopilot",
      status: "blocked",
      turns: 0,
      elapsedMin: 0,
      lastReply: "",
      lastDecision: "",
      attention: null,
      // Runs after both; landing-page is done, api-server is still running → blocked on it.
      dependsOn: ["api-server", "landing-page"],
      blockedBy: ["api-server"],
    },
    {
      id: "e2e-tests",
      cwd: "C:\\dev\\app",
      goal: "Run the end-to-end test suite against the deployed landing page.",
      doneCriteria: "all e2e specs pass",
      permissionMode: "acceptEdits",
      autonomy: "balanced",
      mode: "autopilot",
      status: "queued",
      turns: 0,
      elapsedMin: 0,
      lastReply: "",
      lastDecision: "",
      attention: null,
      // Depends only on a session that's already done → shows the "Runs after" chip, not waiting.
      dependsOn: ["landing-page"],
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
  learning: MOCK_LEARNING,
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
