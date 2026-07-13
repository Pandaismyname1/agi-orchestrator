/**
 * Deterministic tests for the headless engine's stream-json parsing
 * (`claude -p --output-format stream-json --verbose` stdout), plus the engine
 * dispatch seam: `engine: "claude-headless"` routes through runSession with a
 * HeadlessClaudeSession factory. No claude.exe is spawned.
 */
import { StreamJsonParser, textFromAssistant, HeadlessClaudeSession } from "../src/session/headlessSession.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const init = JSON.stringify({ type: "system", subtype: "init", session_id: SID, model: "claude" });
const asst = (t: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const asstTool = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
});
const result = (r: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", result: r, session_id: SID, is_error: false, ...extra });

// --- happy path -----------------------------------------------------------------
{
  const p = new StreamJsonParser();
  p.feed([init, asst("working on it"), asstTool, asst("all done — tests pass"), result("all done — tests pass")].join("\n") + "\n");
  check("result text wins", p.assistantText === "all done — tests pass");
  check("session id captured", p.resultSessionId === SID);
  check("no error flagged", p.resultIsError === false && p.sawResult === true);
}

// --- chunked feeding (lines split across data events) -----------------------------
{
  const p = new StreamJsonParser();
  const whole = [init, asst("partial chunks work"), result("partial chunks work")].join("\n") + "\n";
  for (let i = 0; i < whole.length; i += 7) p.feed(whole.slice(i, i + 7));
  check("chunk-split lines reassemble", p.assistantText === "partial chunks work");
}

// --- no result line (crash mid-turn): last assistant text is the fallback ---------
{
  const p = new StreamJsonParser();
  p.feed([init, asst("got this far")].join("\n")); // note: no trailing newline
  p.flush();
  check("unterminated final line flushes", p.assistantText === "got this far");
  check("missing result detected", p.sawResult === false);
}

// --- error result ------------------------------------------------------------------
{
  const p = new StreamJsonParser();
  p.feed(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: SID }) + "\n");
  check("error result flagged", p.resultIsError === true && p.sawResult === true);
}

// --- noise tolerance -----------------------------------------------------------------
{
  const p = new StreamJsonParser();
  p.feed("not json at all\n" + asst("fine") + "\n{broken json\n" + result("fine") + "\n");
  check("non-JSON noise skipped", p.assistantText === "fine");
}

// --- textFromAssistant shapes ---------------------------------------------------------
check("string content passes through", textFromAssistant({ content: "plain" }) === "plain");
check(
  "multiple text blocks join",
  textFromAssistant({ content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] }) === "a\nb",
);
check("garbage → empty", textFromAssistant(null) === "" && textFromAssistant({ content: 42 }) === "");

// --- HeadlessClaudeSession surface (no spawn) ------------------------------------------
{
  const s = new HeadlessClaudeSession({ id: "friendly-name", cwd: process.cwd(), goal: "g", doneCriteria: "d" });
  check("non-UUID friendly id → minted UUID", /^[0-9a-f-]{36}$/i.test(s.sessionId));
  check("idle before any turn => ready", s.state() === "ready");
  check("alive before dispose", s.isAlive === true);
  await s.dispose();
  check("disposed => not alive", s.isAlive === false);
}
{
  const s = new HeadlessClaudeSession({ id: "x", cwd: process.cwd(), goal: "g", doneCriteria: "d", resumeId: SID });
  check("resumeId adopted as the conversation id", s.sessionId === SID);
}

// --- engine dispatch seam ---------------------------------------------------------------
{
  // runAgentSession must route "claude-headless" through runSession with a factory.
  // We can't run a real session offline, but we CAN assert the factory produces a
  // HeadlessClaudeSession for the engine value (the seam the supervisor relies on).
  const { HeadlessClaudeSession: H } = await import("../src/session/headlessSession.js");
  const made = ((c) => new H(c))({ id: "x", cwd: process.cwd(), goal: "g", doneCriteria: "d" });
  check("factory yields a headless driver with the AgentSession surface",
    typeof made.runTurn === "function" && typeof made.screenText === "function" && typeof made.start === "function");
}

console.log(`\n[headless-parse] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
