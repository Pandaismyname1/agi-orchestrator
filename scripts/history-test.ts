/**
 * Feature 3 check: readRecentMessages returns real multi-message history from
 * an existing transcript (no claude/LLM needed).
 */
import { readRecentMessages } from "../src/transcript/reader.js";

const cwd = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\demo";
const sessionId = process.argv[2];
if (!sessionId) {
  console.error("usage: tsx scripts/history-test.ts <session-uuid>");
  process.exit(1);
}

const msgs = await readRecentMessages(cwd, sessionId, 8);
console.log(`[history-test] got ${msgs.length} message(s):`);
for (const m of msgs) {
  console.log(`  [${m.role}] ${m.text.replace(/\s+/g, " ").slice(0, 90)}`);
}
const ok = msgs.length >= 2 && msgs.some((m) => m.role === "user") && msgs.some((m) => m.role === "assistant");
console.log(`[history-test] => ${ok ? "PASS ✅ (multi-role history)" : "FAIL ⚠️"}`);
process.exit(ok ? 0 : 1);
