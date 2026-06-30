/**
 * Deterministic test for the goal intake assistant. Exercises prompt building +
 * the robust response parser with a stub LLM (no network), asserting:
 *  - a "clear" verdict yields no questions/suggestions,
 *  - a "vague" verdict surfaces questions + suggestions (≤3 questions),
 *  - it fails OPEN (treats as clear) on unparseable / empty model output,
 *  - "vague" with nothing actionable is downgraded to "clear" (no nagging),
 *  - assessGoal wires the LLM through end-to-end.
 */
import { buildIntakePrompt, parseIntake, assessGoal } from "../src/brain/intake.js";
import type { LocalLLM } from "../src/brain/provider.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ---- prompt building --------------------------------------------------------
const msgs = buildIntakePrompt({ cwd: "C:\\proj", goal: "make it good", doneCriteria: "works" });
check("prompt has a system + user message", msgs.length === 2 && msgs[0]?.role === "system");
check("user message carries the goal", !!msgs[1]?.content.includes("make it good"));
check("user message carries the cwd", !!msgs[1]?.content.includes("C:\\proj"));

// ---- clear verdict ----------------------------------------------------------
const clear = parseIntake(
  JSON.stringify({ clarity: "clear", assessment: "Specific and checkable.", questions: [], suggestedGoal: "", suggestedDoneCriteria: "" }),
);
check("clear stays clear", clear.clarity === "clear");
check("clear has no questions", clear.questions.length === 0);
check("clear drops suggestions", !clear.suggestedGoal && !clear.suggestedDoneCriteria);

// ---- vague verdict, fenced JSON + extra prose -------------------------------
const vagueRaw = "Here's my take:\n```json\n" +
  JSON.stringify({
    clarity: "vague",
    assessment: "Too broad.",
    questions: ["What's in scope?", "How is 'done' checked?", "Any constraints?", "extra ignored q"],
    suggestedGoal: "  Refactor the auth module only.  ",
    suggestedDoneCriteria: "Tests pass and a PR is opened.",
  }) +
  "\n```\nHope that helps!";
const vague = parseIntake(vagueRaw);
check("vague parsed from a fenced block", vague.clarity === "vague");
check("questions capped at 3", vague.questions.length === 3);
check("suggested goal trimmed", vague.suggestedGoal === "Refactor the auth module only.");
check("suggested done present", vague.suggestedDoneCriteria === "Tests pass and a PR is opened.");

// ---- fail-open on garbage ---------------------------------------------------
const garbage = parseIntake("the model said something unhelpful and not JSON at all");
check("garbage fails open to clear", garbage.clarity === "clear");
check("garbage yields no questions", garbage.questions.length === 0);

// ---- vague-but-empty is downgraded (no nagging) -----------------------------
const empty = parseIntake(JSON.stringify({ clarity: "vague", assessment: "Eh.", questions: [], suggestedGoal: "", suggestedDoneCriteria: "" }));
check("vague with nothing actionable -> clear", empty.clarity === "clear");

// ---- assessGoal wires the LLM end-to-end ------------------------------------
const stub = {
  chat: async () =>
    JSON.stringify({ clarity: "vague", assessment: "Needs scope.", questions: ["Which files?"], suggestedGoal: "Tighter goal.", suggestedDoneCriteria: "Checkable." }),
} as unknown as LocalLLM;
const result = await assessGoal(stub, { goal: "do stuff", doneCriteria: "ok" });
check("assessGoal returns the parsed verdict", result.clarity === "vague" && result.questions[0] === "Which files?");

console.log(`\n[intake] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
