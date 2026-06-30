/**
 * Deterministic test: a pending AskUserQuestion choice menu is surfaced to the
 * brain from the transcript. The session Esc-dismisses the modal (it never reaches
 * a normal turn-end), so the ONLY way the brain learns what Claude wanted is by
 * the transcript reader rendering the AskUserQuestion tool_use as readable text.
 * Here we feed raw transcript JSONL through the pure parsers and assert the
 * question + options come through (for both the last-message and history reads).
 */
import { messagesFromRaw, lastAssistantFromRaw } from "../src/transcript/reader.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

// A realistic transcript: our injected prompt, then an assistant turn whose ONLY
// content block is an AskUserQuestion tool_use (no text) — the exact shape that
// used to read back as "" and leave the brain with nothing to answer.
const askLine = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "How much should the v1 manifest cover?",
              header: "R6 scope",
              multiSelect: false,
              options: [
                { label: "Manifest from existing data", description: "Lowest risk, ships now." },
                { label: "Manifest + per-region basis UI", description: "Larger; touches the editor." },
                { label: "Defer R6", description: "Leave it for later." },
              ],
            },
            {
              question: "Which records should the export include?",
              header: "Export",
              multiSelect: true,
              options: [
                { label: "Redactions", description: "what was hidden" },
                { label: "Page counts", description: "per-page totals" },
              ],
            },
          ],
        },
      },
    ],
  },
});
const userLine = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "Finish the GDPR backlog." }] },
});
const raw = [userLine, askLine].join("\n");

const last = lastAssistantFromRaw(raw);
check("last assistant message is non-empty (tool_use-only turn no longer reads as '')", last.length > 0);
check("rendered question text present", last.includes("How much should the v1 manifest cover?"));
check("rendered option labels present", last.includes("Manifest from existing data") && last.includes("Defer R6"));
check("rendered option descriptions present", last.includes("Lowest risk, ships now."));
check("multi-select question marked", last.includes("[choose one or more]"));
check("answer instruction present (tells the brain to reply in plain language)", /Reply in plain language/i.test(last));

const history = messagesFromRaw(raw, 8);
check("history includes the user prompt and the assistant question", history.length === 2);
check(
  "history assistant entry carries the rendered question",
  history[1]?.role === "assistant" && (history[1]?.text ?? "").includes("How much should the v1 manifest cover?"),
);

// A normal text-only assistant turn is unaffected (no choice noise injected).
const plain = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "Done — all tests pass." }] },
});
check("plain assistant turn unchanged", lastAssistantFromRaw(plain) === "Done — all tests pass.");

console.log(`\n[choice] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
