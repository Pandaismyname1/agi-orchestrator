/**
 * Deterministic tests for the Qwen fallback layer (Phase 3):
 *  - triageScreen: parses/validates the local model's screen classification and
 *    never throws on garbage or a dead endpoint.
 *  - triageKeyBytes: the safety rail — only Enter/Esc/a single digit are ever
 *    typed from the triage path (decision D7), never free text.
 *  - decideNextStep self-repair: one corrective retry on malformed JSON before
 *    the fail-safe stop.
 *  - escalation timeout: an "autonomous" session auto-picks the first option /
 *    auto-denies a gate; a "balanced" session waits.
 */
import { triageScreen } from "../src/brain/triage.js";
import { triageKeyBytes } from "../src/session/claudeSession.js";
import { decideNextStep } from "../src/brain/decide.js";
import { Supervisor, type RunFn } from "../src/server/supervisor.js";
import type { LocalLLM } from "../src/brain/provider.js";
import type { AppConfig, SessionConfig } from "../src/types.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};
const stubLlm = (...replies: string[]): LocalLLM => {
  let i = 0;
  return {
    chat: async () => replies[Math.min(i++, replies.length - 1)]!,
    health: async () => ({ ok: true, detail: "stub" }),
  } as unknown as LocalLLM;
};

// --- triageScreen -------------------------------------------------------------
{
  const t = await triageScreen(stubLlm('{"state":"survey","key":"0","reason":"feedback poll"}'), "How is Claude doing?");
  check("valid triage parsed", t?.state === "survey" && t?.key === "0");
}
{
  const t = await triageScreen(stubLlm('Sure! Here is my answer:\n```json\n{"state":"ready"}\n```'), "x");
  check("fenced/prose-wrapped triage still parses", t?.state === "ready" && t?.key === undefined);
}
{
  const t = await triageScreen(stubLlm('{"state":"launch-missiles","key":"enter"}'), "x");
  check("invalid state coerces to unknown (key kept for the rail to filter)", t?.state === "unknown");
}
{
  const t = await triageScreen(stubLlm("total garbage, no json"), "x");
  check("garbage → null (falls through the ladder)", t === null);
}
{
  const dead = {
    chat: async () => {
      throw new Error("ECONNREFUSED");
    },
  } as unknown as LocalLLM;
  check("dead endpoint → null, never throws", (await triageScreen(dead, "x")) === null);
}

// --- triageKeyBytes: the D7 safety rail ----------------------------------------
check("enter → CR", triageKeyBytes("enter") === "\r");
check("Esc → ESC byte", triageKeyBytes("Esc") === "\x1b");
check("digit passes", triageKeyBytes("0") === "0");
check("multi-char digit rejected", triageKeyBytes("12") === null);
check("free text rejected", triageKeyBytes("rm -rf /") === null);
check("'y' rejected (not in the safe set)", triageKeyBytes("y") === null);
check("undefined → null", triageKeyBytes(undefined) === null);

// --- decideNextStep JSON self-repair -------------------------------------------
const sess: SessionConfig = { id: "s", cwd: "C:\\x", goal: "ship it", doneCriteria: "shipped" };
{
  const llm = stubLlm("I think we should continue with the tests", '{"action":"continue","prompt":"run the tests","reason":"next step"}');
  const d = await decideNextStep(llm, sess, "did stuff", 3);
  check("garbage then valid → repaired to continue", d.action === "continue" && d.prompt === "run the tests");
}
{
  const llm = stubLlm("garbage one", "garbage two");
  const d = await decideNextStep(llm, sess, "did stuff", 3);
  check("garbage twice → fail-safe stop", d.action === "stop" && /unparseable/.test(d.reason));
}
{
  const llm = stubLlm('{"action":"continue","prompt":"go on","reason":"fine"}');
  const d = await decideNextStep(llm, sess, "did stuff", 3);
  check("clean first reply → no retry needed", d.action === "continue" && d.prompt === "go on");
}

// --- escalation timeout (autonomous persona only) -------------------------------
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cfgWith = (timeoutMin: number): AppConfig => ({
  provider: { baseUrl: "http://localhost:1234/v1", model: "unused", apiKey: "local" },
  limits: { maxTurns: 5, maxWallClockMin: 8, pingPongThreshold: 3 },
  sessions: [],
  brain: { escalationTimeoutMin: timeoutMin },
});
// Runner that escalates once and records how the escalation resolved.
let resolvedLabel: string | undefined;
let gateResolution: string | undefined;
const escalatingRunner: RunFn = async (s, opts) => {
  const res = await opts.resolveAttention!({
    id: "att-1",
    sessionId: s.id,
    turnNumber: 1,
    question: "Which path?",
    options: [
      { label: "Path A (recommended)", rationale: "fast", prompt: "do A" },
      { label: "Path B", rationale: "slow", prompt: "do B" },
    ],
    createdAt: Date.now(),
  });
  resolvedLabel = res.kind === "answer" ? res.label : "stopped";
  const g = await opts.resolveGate!({ id: "gate-1", sessionId: s.id, summary: "Bash: rm -rf build" });
  gateResolution = g.kind;
};
{
  // 0.001 min = 60ms — the timeout fires fast in the test.
  const sup = new Supervisor(cfgWith(0.001), undefined, undefined, escalatingRunner);
  const a = sup.addSession({ cwd: "C:\\x", goal: "g", doneCriteria: "d", autonomy: "autonomous" });
  sup.start(a.id);
  await tick(400);
  check("autonomous: escalation auto-picked option 1", resolvedLabel === "auto (timed out): Path A (recommended)");
  check("autonomous: dangerous gate auto-DENIED (never approved)", gateResolution === "deny");
  void sup.shutdown();
}
{
  resolvedLabel = undefined;
  gateResolution = undefined;
  const sup = new Supervisor(cfgWith(0.001), undefined, undefined, escalatingRunner);
  const a = sup.addSession({ cwd: "C:\\x", goal: "g", doneCriteria: "d", autonomy: "balanced" });
  sup.start(a.id);
  await tick(400);
  check("balanced: escalation still waiting for the human", resolvedLabel === undefined);
  const v = sup.list().find((s) => s.id === a.id)!;
  check("balanced: session parked at needs-input", v.status === "needs-input");
  sup.resolveAttention(a.id, { optionIndex: 1 });
  await tick(50);
  check("balanced: human pick resolves it", resolvedLabel === "Path B");
  void sup.shutdown();
}

console.log(`\n[triage] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
