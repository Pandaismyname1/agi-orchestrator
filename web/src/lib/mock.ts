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
  RunningClaude,
  Analytics,
  CatalogEntry,
  RegistryResult,
  HealthReport,
} from "./types";

/** Demo system-health report for the Health modal under `?mock`. */
export const MOCK_HEALTH: HealthReport = {
  status: "degraded",
  version: "0.0.1",
  uptimeSec: 6 * 3600 + 23 * 60,
  llm: { ok: true, detail: "qwen3.5:9b ready (1 model loaded)", model: "qwen3.5:9b", baseUrl: "http://localhost:11434/v1" },
  db: { path: "C:\\Users\\panda\\Desktop\\AGI\\agi.db", sizeBytes: 2_446_336, sessions: 8, runs: 137 },
  fleet: { total: 8, running: 3, needsInput: 1, error: 1 },
  checkedAt: Date.now(),
};

/** Demo remote registry for the Templates modal under `?mock`. */
export const MOCK_REGISTRY: RegistryResult = {
  canBrowse: true,
  canPublish: true,
  recipes: [
    { catalogId: "gdpr-audit", name: "GDPR data-flow audit", description: "Map personal-data flows and flag compliance gaps.", goal: "Audit where personal data is collected, stored, and shared; report gaps.", doneCriteria: "A data-flow map + prioritized gap list is written.", permissionMode: "default", autonomy: "cautious", startMode: "autopilot", author: "community", version: "1.2.0" },
    { catalogId: "a11y-sweep", name: "Accessibility sweep", description: "Find and fix WCAG issues across the UI.", goal: "Audit the UI for WCAG 2.1 AA issues and fix the straightforward ones.", doneCriteria: "Automated a11y checks pass; remaining issues are logged.", permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot", author: "a11y-guild", version: "0.4.1" },
    { catalogId: "i18n-extract", name: "i18n string extraction", description: "Extract hardcoded UI strings into a locale file.", goal: "Extract hardcoded user-facing strings into the i18n catalog and wire them up.", doneCriteria: "Strings are externalized; the app builds and renders unchanged.", permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot", author: "community" },
  ],
};

/** Demo starter catalog for the Templates modal under `?mock`. */
export const MOCK_CATALOG: CatalogEntry[] = [
  { catalogId: "bugfix-sprint", name: "Bug-fix sprint", description: "Triage and fix open bugs until the test suite is green.", goal: "Find and fix the failing tests and open bugs.", doneCriteria: "The full test suite passes.", permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot", installed: true },
  { catalogId: "test-coverage", name: "Test-coverage push", description: "Raise automated test coverage on under-tested code.", goal: "Add meaningful tests for the least-covered modules.", doneCriteria: "New tests pass; critical paths covered.", permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot", installed: false },
  { catalogId: "dep-upgrade", name: "Dependency upgrade", description: "Bump dependencies and fix any resulting breakage.", goal: "Upgrade outdated dependencies and fix breakage.", doneCriteria: "Builds, type-checks, and all tests pass.", permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot", installed: false },
  { catalogId: "docs-polish", name: "Docs & README polish", description: "Improve the README and developer docs for clarity.", goal: "Improve the README and developer documentation.", doneCriteria: "Docs are accurate and examples run.", permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot", installed: false },
  { catalogId: "security-audit", name: "Security audit", description: "Review the codebase for vulnerabilities and report findings.", goal: "Audit the codebase for security issues and report them.", doneCriteria: "A prioritized findings report is written.", permissionMode: "default", autonomy: "cautious", startMode: "autopilot", installed: false },
  { catalogId: "refactor-cleanup", name: "Refactor & cleanup", description: "Reduce duplication and dead code without changing behavior.", goal: "Refactor for clarity with no behavior changes.", doneCriteria: "Tests still pass; duplication reduced.", permissionMode: "acceptEdits", autonomy: "balanced", startMode: "autopilot", installed: false },
];

/** Demo analytics report for the Analytics modal under `?mock`. */
export const MOCK_ANALYTICS: Analytics = {
  generatedAt: Date.now(),
  fleet: {
    sessions: 8,
    runs: 47,
    turns: 612,
    avgTurns: 13,
    successRate: 0.83,
    errorRate: 0.17,
    interventionRate: 0.21,
    latency: { count: 612, avgMs: 8200, p50Ms: 6400, p95Ms: 21500, maxMs: 63200 },
    decisions: { continue: 531, stop: 47, escalate: 34 },
    feedback: { up: 38, down: 9 },
  },
  sessions: [
    { id: "api-server", goal: "Build the REST API with auth, rate limiting, and OpenAPI docs.", runs: 14, turns: 233, avgTurns: 16.6, completedRuns: 12, erroredRuns: 1, successRate: 0.92, errorRate: 0.08, interventionRate: 0.29, latency: { count: 233, avgMs: 9100, p50Ms: 7200, p95Ms: 24800, maxMs: 63200 }, decisions: { continue: 210, stop: 14, escalate: 9 }, feedback: { up: 18, down: 2 }, lastRunAt: Date.now() - 41 * 60_000 },
    { id: "docs-site", goal: "Write and polish the documentation site with examples.", runs: 9, turns: 121, avgTurns: 13.4, completedRuns: 8, erroredRuns: 0, successRate: 1, errorRate: 0, interventionRate: 0.11, latency: { count: 121, avgMs: 5600, p50Ms: 4800, p95Ms: 14200, maxMs: 28900 }, decisions: { continue: 108, stop: 9, escalate: 4 }, feedback: { up: 7, down: 3 }, lastRunAt: Date.now() - 18 * 60_000 },
    { id: "refactor-db", goal: "Migrate the data layer from raw SQL to the query builder.", runs: 7, turns: 96, avgTurns: 13.7, completedRuns: 5, erroredRuns: 2, successRate: 0.71, errorRate: 0.29, interventionRate: 0.43, latency: { count: 96, avgMs: 11800, p50Ms: 9100, p95Ms: 32400, maxMs: 51000 }, decisions: { continue: 80, stop: 7, escalate: 9 }, feedback: { up: 5, down: 4 }, lastRunAt: Date.now() - 6 * 60_000 },
    { id: "landing-page", goal: "Ship the marketing landing page and hook up analytics.", runs: 6, turns: 84, avgTurns: 14, completedRuns: 6, erroredRuns: 0, successRate: 1, errorRate: 0, interventionRate: 0.17, latency: { count: 84, avgMs: 4900, p50Ms: 4200, p95Ms: 11800, maxMs: 22300 }, decisions: { continue: 74, stop: 6, escalate: 4 }, feedback: { up: 6, down: 0 }, lastRunAt: Date.now() - 3 * 3600_000 },
    { id: "data-pipeline", goal: "Build the nightly ETL job and add monitoring.", runs: 5, turns: 51, avgTurns: 10.2, completedRuns: 3, erroredRuns: 2, successRate: 0.6, errorRate: 0.4, interventionRate: 0.4, latency: { count: 51, avgMs: 13400, p50Ms: 10200, p95Ms: 38900, maxMs: 61000 }, decisions: { continue: 42, stop: 5, escalate: 4 }, feedback: { up: 1, down: 0 }, lastRunAt: Date.now() - 5 * 3600_000 },
  ],
  daily: [
    { day: "2026-06-24", runs: 5, turns: 64 },
    { day: "2026-06-25", runs: 8, turns: 121 },
    { day: "2026-06-26", runs: 6, turns: 73 },
    { day: "2026-06-27", runs: 9, turns: 142 },
    { day: "2026-06-28", runs: 4, turns: 38 },
    { day: "2026-06-29", runs: 7, turns: 98 },
    { day: "2026-06-30", runs: 8, turns: 76 },
  ],
  learning: { globalVersions: 3, projectProfiles: 2, totalExamples: 64 },
};

/** Demo running-claude processes for the Attach modal under `?mock`. */
export const MOCK_RUNNING: RunningClaude[] = [
  {
    pid: 48217,
    sessionId: "c7d8e9f0-1a2b-3c4d-5e6f-7a8b9c0d1e2f",
    commandLine: "node /usr/local/bin/claude --session-id c7d8e9f0-1a2b-3c4d-5e6f-7a8b9c0d1e2f --dangerously-skip-permissions",
    attached: false,
  },
  {
    pid: 50934,
    sessionId: "a1b2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
    commandLine: "node /usr/local/bin/claude --session-id a1b2c3d4-… (already driven)",
    attached: true,
  },
];

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
  feedback: { up: 9, down: 3 },
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
    reliability: { retries: 3, retryBackoffMs: 400, brainPollSeconds: 15 },
    quietHours: { enabled: true, start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5], allowUrgent: true },
    workflowDepthCap: 10,
    automationChainCap: 8,
  },
  quietActive: true,
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
      lastDecision: "→ wire the /auth refresh-token endpoint and add a test (tests still red on refresh)",
      lastDecisionFeedback: "up",
      feedback: { up: 5, down: 1 },
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
      lastDecision: "→ add a quickstart code sample to the landing page (docs need a runnable example)",
      feedback: { up: 2, down: 3 },
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
      notify: { events: ["error"] },
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
      lastDecision: "✅ opened PR: https://github.com/me/www/pull/128",
      attention: null,
      canContinue: true,
      schedule: { enabled: true, dailyAt: "02:00" },
      autoPr: { mode: "ready" },
      notify: { mute: true },
      prState: "open",
      prUrl: "https://github.com/me/www/pull/128",
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
      status: "blocked",
      turns: 0,
      elapsedMin: 0,
      lastReply: "",
      lastDecision: "manual review — step 11 of an 11-deep workflow (cap 10); start it yourself to continue",
      attention: null,
      // Deps are met, but the workflow is past the depth cap → paused for manual review.
      dependsOn: ["landing-page"],
      reviewRequired: true,
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
  templates: [
    {
      id: "tpl-bugfix",
      name: "Bug-fix autopilot",
      description: "Reproduce, fix, and add a regression test.",
      category: "Bug fixes",
      goal: "Reproduce the reported bug, fix the root cause, and add a regression test.",
      doneCriteria: "the bug is fixed, a failing-then-passing test is added, and the suite is green",
      permissionMode: "acceptEdits",
      autonomy: "balanced",
      startMode: "autopilot",
      createdAt: 1_780_000_000_000,
      updatedAt: 1_782_000_000_000,
    },
    {
      id: "tpl-flaky",
      name: "Flaky-test hunt",
      description: "Find and stabilize intermittently failing tests.",
      category: "Bug fixes",
      goal: "Identify flaky tests, diagnose the race/ordering cause, and make them deterministic.",
      doneCriteria: "the suite passes 10 runs in a row",
      permissionMode: "acceptEdits",
      autonomy: "balanced",
      startMode: "autopilot",
      createdAt: 1_779_500_000_000,
      updatedAt: 1_781_500_000_000,
    },
    {
      id: "tpl-audit",
      name: "Security audit (manual)",
      description: "Read-only review; you seed the scope first.",
      category: "Audits",
      goal: "Audit the codebase for security issues and write up findings.",
      doneCriteria: "a prioritized findings report with file/line references",
      permissionMode: "default",
      autonomy: "cautious",
      startMode: "manual",
      createdAt: 1_779_000_000_000,
      updatedAt: 1_781_000_000_000,
    },
    {
      id: "tpl-scratch",
      name: "Quick scratch task",
      description: "An uncategorized one-off.",
      goal: "Do a small ad-hoc task.",
      doneCriteria: "the task is done",
      permissionMode: "acceptEdits",
      autonomy: "balanced",
      startMode: "autopilot",
      createdAt: 1_778_000_000_000,
      updatedAt: 1_780_000_000_000,
    },
  ],
  webhooks: [
    {
      id: "wh-slack",
      name: "Slack #builds",
      url: "https://hooks.slack.com/services/T000/B000/xxxx",
      format: "slack",
      events: ["done", "error", "needs-input"],
      enabled: true,
      createdAt: 1_780_000_000_000,
      updatedAt: 1_782_000_000_000,
    },
    {
      id: "wh-ops",
      name: "Ops JSON sink",
      url: "https://ops.example.com/agi/events",
      format: "json",
      enabled: false,
      createdAt: 1_779_000_000_000,
      updatedAt: 1_780_500_000_000,
    },
  ],
  automations: [
    {
      id: "auto-chain",
      name: "Deploy after API build",
      enabled: true,
      on: ["done"],
      match: { sessionId: "api-server" },
      actions: [{ kind: "start", target: "deploy-prod" }],
      createdAt: 1_780_000_000_000,
      updatedAt: 1_782_000_000_000,
    },
    {
      id: "auto-halt",
      name: "Halt & notify on any error",
      enabled: true,
      on: ["error"],
      actions: [
        { kind: "stop", target: "$self" },
        { kind: "notify", message: "A session errored — paused for review." },
      ],
      createdAt: 1_779_000_000_000,
      updatedAt: 1_781_000_000_000,
    },
    {
      id: "auto-off",
      name: "Restart e2e on rate-limit (disabled)",
      enabled: false,
      on: ["rate-limited"],
      match: { cwdContains: "e2e" },
      actions: [{ kind: "start", target: "$self" }],
      createdAt: 1_778_000_000_000,
      updatedAt: 1_779_500_000_000,
    },
    {
      id: "auto-handoff",
      name: "Take the wheel when the DB migration needs review",
      enabled: true,
      on: ["needs-input"],
      match: { sessionId: "refactor-db" },
      actions: [
        { kind: "setMode", target: "refactor-db", mode: "manual" },
        { kind: "webhook", webhook: "Slack #builds" },
      ],
      createdAt: 1_781_500_000_000,
      updatedAt: 1_782_200_000_000,
    },
  ],
  automationLog: [
    { at: Date.now() - 4 * 60_000, ruleId: "auto-chain", ruleName: "Deploy after API build", event: "done", kind: "start", from: "api-server", target: "deploy-prod", outcome: "ok" },
    { at: Date.now() - 38 * 60_000, ruleId: "auto-halt", ruleName: "Halt & notify on any error", event: "error", kind: "stop", from: "data-pipeline", target: "data-pipeline", outcome: "ok" },
    { at: Date.now() - 38 * 60_000, ruleId: "auto-halt", ruleName: "Halt & notify on any error", event: "error", kind: "notify", from: "data-pipeline", outcome: "skipped", note: "no webhook configured" },
    { at: Date.now() - 3 * 3600_000, ruleId: "auto-chain", ruleName: "Deploy after API build", event: "done", kind: "start", from: "api-server", target: "deploy-prod", outcome: "ok" },
    { at: Date.now() - 26 * 3600_000, ruleId: "auto-halt", ruleName: "Halt & notify on any error", event: "error", kind: "stop", from: "refactor-db", target: "refactor-db", outcome: "error", note: "session is running" },
  ],
  attached: [
    {
      sessionId: "a1b2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
      goal: "Refactor the billing module to use the new pricing API and keep tests green.",
      doneCriteria: "All billing tests pass and the legacy pricing client is removed.",
      turns: 7,
      registeredAt: Date.now() - 26 * 60_000,
      lastActivity: Date.now() - 90_000,
      lastAction: "stop",
      lastReason: "needs your decision: deploy to staging or wait for review?",
      needsInput: true,
    },
    {
      sessionId: "f9e8d7c6-b5a4-3210-9876-543210fedcba",
      goal: "Write end-to-end docs for the public SDK.",
      doneCriteria: "Every public method has an example; the docs site builds.",
      turns: 0,
      registeredAt: Date.now() - 40_000,
    },
  ],
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
      files_changed: 2,
      snapshot: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      diff: JSON.stringify({
        files: [
          { file: "src/auth/tokens.ts", added: 38, removed: 4 },
          { file: "tests/auth.spec.ts", added: 27, removed: 0 },
        ],
        patch:
          "diff --git a/src/auth/tokens.ts b/src/auth/tokens.ts\n" +
          "@@ -10,6 +10,12 @@ export function issueRefreshToken(userId: string) {\n" +
          "-  return sign({ sub: userId });\n" +
          "+  const jti = randomUUID();\n" +
          "+  store.save(jti, userId);\n" +
          "+  return sign({ sub: userId, jti });\n" +
          " }\n" +
          "diff --git a/tests/auth.spec.ts b/tests/auth.spec.ts\n" +
          "@@ -0,0 +1,5 @@\n" +
          '+test("rotates the token on refresh", async () => {\n' +
          "+  const a = await login();\n" +
          "+  const b = await refresh(a.refresh);\n" +
          "+  expect(b.refresh).not.toBe(a.refresh);\n" +
          "+});\n",
        truncated: false,
      }),
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
      feedback: "up",
    },
    {
      n: 2,
      action: "continue",
      reason: "Auth works and the tests pass; next add rate limiting.",
      prompt: "Add rate-limiting middleware and document it.",
      feedback: "down",
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
