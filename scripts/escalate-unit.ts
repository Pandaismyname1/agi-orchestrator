/**
 * Deterministic unit test for the brain's escalate handling. Uses a fake LLM so
 * there's no network — just verifies decideNextStep parses each action shape.
 */
import { decideNextStep } from "../src/brain/decide.js";
import type { LocalLLM } from "../src/brain/provider.js";
import type { SessionConfig } from "../src/types.js";

const session: SessionConfig = { id: "t", cwd: "x", goal: "g", doneCriteria: "d" };
const fakeLLM = (reply: string): LocalLLM =>
  ({ chat: async () => reply }) as unknown as LocalLLM;

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

// 1. escalate with options -> escalate, options parsed
const d1 = await decideNextStep(
  fakeLLM(
    `{"action":"escalate","reason":"need a call","question":"Which DB?","options":[
      {"label":"Postgres","rationale":"robust","prompt":"Use PostgreSQL"},
      {"label":"SQLite","rationale":"simple","prompt":"Use SQLite"}]}`,
  ),
  session, "agent asked which database", 1,
);
check("escalate action", d1.action === "escalate");
check("question parsed", d1.question === "Which DB?");
check("2 options parsed", (d1.options?.length ?? 0) === 2);
check("option has prompt", d1.options?.[0]?.prompt === "Use PostgreSQL");

// 2. escalate WITHOUT options -> fail-safe stop
const d2 = await decideNextStep(
  fakeLLM(`{"action":"escalate","reason":"hmm","question":"unclear","options":[]}`),
  session, "x", 1,
);
check("escalate w/o options -> stop", d2.action === "stop");

// 3. continue still works
const d3 = await decideNextStep(
  fakeLLM(`{"action":"continue","prompt":"do the thing","reason":"progress"}`),
  session, "x", 1,
);
check("continue action", d3.action === "continue" && d3.prompt === "do the thing");

// 4. stop still works
const d4 = await decideNextStep(fakeLLM(`{"action":"stop","reason":"done"}`), session, "x", 1);
check("stop action", d4.action === "stop");

// 5. malformed options dropped (no label/prompt) -> fail-safe stop
const d5 = await decideNextStep(
  fakeLLM(`{"action":"escalate","question":"q","options":[{"rationale":"no label or prompt"}]}`),
  session, "x", 1,
);
check("escalate w/ junk options -> stop", d5.action === "stop");

console.log(`\n[escalate-unit] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
