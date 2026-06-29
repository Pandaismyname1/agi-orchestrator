/**
 * Deterministic test for operator personas: buildSystemPrompt produces distinct,
 * autonomy-appropriate guidance while keeping the base decision contract.
 */
import { buildSystemPrompt } from "../src/brain/decide.js";

let pass = true;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); if (!c) pass = false; };

const cautious = buildSystemPrompt("cautious");
const balanced = buildSystemPrompt("balanced");
const autonomous = buildSystemPrompt("autonomous");
const def = buildSystemPrompt(undefined);

check("cautious mentions CAUTIOUS + escalate generously", /CAUTIOUS/.test(cautious) && /generously/i.test(cautious));
check("autonomous mentions AUTONOMOUS + only escalate for truly", /AUTONOMOUS/.test(autonomous) && /only escalate for truly/i.test(autonomous));
check("balanced mentions BALANCED", /BALANCED/.test(balanced));
check("default == balanced", def === balanced);
check("personas differ from each other", cautious !== balanced && balanced !== autonomous);

// base contract preserved in all
for (const [name, p] of [["cautious", cautious], ["balanced", balanced], ["autonomous", autonomous]] as const) {
  check(`${name} keeps JSON contract`, /"action":"continue"\|"stop"\|"escalate"/.test(p));
  check(`${name} keeps escalate guidance`, /Pick "escalate"/.test(p));
}

console.log(`\n[persona] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
