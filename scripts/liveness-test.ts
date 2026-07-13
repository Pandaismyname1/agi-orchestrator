/**
 * Deterministic tests for the transcript ground-truth helpers that drive the
 * frozen-screen recovery ladder: `turnEndedInRaw` (is the transcript's tail a
 * FINAL assistant message?) and the offset math behind "did the reply land"
 * (`assistantTextAfterOffset`, exercised through a temp file).
 */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  turnEndedInRaw,
  assistantTextAfterOffset,
  transcriptStat,
  transcriptPath,
  transcriptResumable,
  encodeProjectDir,
} from "../src/transcript/reader.js";

let pass = true;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`);
  if (!cond) pass = false;
};

const asst = (content: unknown) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const user = (content: unknown) => JSON.stringify({ type: "user", message: { role: "user", content } });
const text = (t: string) => ({ type: "text", text: t });
const toolUse = () => ({ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } });

// --- turnEndedInRaw ---------------------------------------------------------
check("empty transcript => not ended", turnEndedInRaw("") === false);
check(
  "tail = final assistant text => ended",
  turnEndedInRaw([user([text("do the thing")]), asst([text("done — all tests pass")])].join("\n")) === true,
);
check(
  "tail = assistant tool_use (work in flight) => not ended",
  turnEndedInRaw([user([text("go")]), asst([text("running…"), toolUse()])].join("\n")) === false,
);
check(
  "tail = user tool_result => not ended",
  turnEndedInRaw([asst([toolUse()]), user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }])].join("\n")) ===
    false,
);
check(
  "tail = injected user prompt => not ended",
  turnEndedInRaw([asst([text("previous reply")]), user([text("continue")])].join("\n")) === false,
);
check(
  "trailing non-message entries are skipped",
  turnEndedInRaw(
    [asst([text("final answer")]), JSON.stringify({ type: "system", note: "x" }), JSON.stringify({ type: "summary" })].join(
      "\n",
    ),
  ) === true,
);
check("string content assistant tail => ended", turnEndedInRaw(asst("plain string reply")) === true);
check("malformed tail line is skipped", turnEndedInRaw(asst([text("fine")]) + "\n{not json") === true);
check("assistant tail with EMPTY text => not ended", turnEndedInRaw(asst([text("  ")])) === false);

// --- assistantTextAfterOffset (through a real temp transcript) ---------------
// Build the exact on-disk layout reader.ts expects: <home>/.claude/projects/<enc>/<id>.jsonl
const fakeHome = mkdtempSync(path.join(os.tmpdir(), "agi-liveness-"));
const realHome = os.homedir;
(os as { homedir: () => string }).homedir = () => fakeHome;
try {
  const cwd = "C:\\proj\\demo";
  const sid = "11111111-2222-3333-4444-555555555555";
  const dir = path.dirname(transcriptPath(cwd, sid));
  mkdirSync(dir, { recursive: true });
  const before = [user([text("first prompt")]), asst([text("first reply")])].join("\n") + "\n";
  writeFileSync(transcriptPath(cwd, sid), before);

  const st = await transcriptStat(cwd, sid);
  check("transcriptStat sees the file", st !== null && st.size > 0);
  const offset = st!.size;

  check(
    "no reply after offset yet => null",
    (await assistantTextAfterOffset(cwd, sid, offset)) === null,
  );
  check(
    "old reply is BEFORE the offset (not returned)",
    (await assistantTextAfterOffset(cwd, sid, 0)) === "first reply",
  );

  // The next turn lands.
  writeFileSync(
    transcriptPath(cwd, sid),
    before + [user([text("continue")]), asst([text("second reply")])].join("\n") + "\n",
  );
  check(
    "reply after offset => returned",
    (await assistantTextAfterOffset(cwd, sid, offset)) === "second reply",
  );
  check(
    "missing transcript => null",
    (await assistantTextAfterOffset(cwd, "99999999-0000-0000-0000-000000000000", 0)) === null,
  );
  check("encodeProjectDir strips non-alphanumerics", encodeProjectDir("C:\\a b/c") === "C--a-b-c");

  // --- transcriptResumable: --resume poison-file guard ---------------------------
  check("transcript with real messages => resumable", transcriptResumable(cwd, sid) === true);
  check(
    "missing transcript => NOT resumable",
    transcriptResumable(cwd, "99999999-0000-0000-0000-000000000001") === false,
  );
  const poison = "88888888-0000-0000-0000-000000000002";
  writeFileSync(transcriptPath(cwd, poison), ""); // 0-byte file: exists but message-less
  check("0-byte transcript => NOT resumable", transcriptResumable(cwd, poison) === false);
  writeFileSync(
    transcriptPath(cwd, poison),
    JSON.stringify({ type: "mode", mode: "acceptEdits" }) + "\n" + JSON.stringify({ type: "permission-mode" }) + "\n",
  );
  check("metadata-only transcript (the poison file) => NOT resumable", transcriptResumable(cwd, poison) === false);
} finally {
  (os as { homedir: () => string }).homedir = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
}

console.log(`\n[liveness] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
