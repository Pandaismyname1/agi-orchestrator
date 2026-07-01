/**
 * Deterministic test for OpenCode support: seed a fake ~/.local/share/opencode
 * storage tree (session / project / message / part files) and verify discovery
 * (metadata, turn count, recency order, sub-session skip, non-drivable flag) and
 * the message reader (message → part join, chronological order). No opencode.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  OpenCodeDiscovery,
  readOpenCodeMessages,
  readLastOpenCodeAssistant,
  defaultOpenCodeRoot,
} from "../src/opencode.js";
import { discoverAll } from "../src/discovery.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\opencode-root";
rmSync(ROOT, { recursive: true, force: true });

const storage = path.join(ROOT, "storage");
const write = (rel: string, obj: unknown) => {
  const full = path.join(storage, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, JSON.stringify(obj));
};

// --- project ---------------------------------------------------------------
const PROJ = "proj1111";
write(`project/${PROJ}.json`, { id: PROJ, worktree: "C:\\proj\\fit", vcs: "git" });

// --- session A: 2 assistant turns, real conversation ----------------------
const A = "ses_AAAA";
write(`session/${PROJ}/${A}.json`, {
  id: A,
  projectID: PROJ,
  directory: "C:\\proj\\fit\\sub",
  title: "Add offline sync",
  time: { created: 1000, updated: 5000 },
});
// messages: user → assistant → user → assistant
write(`message/${A}/msg_a1.json`, { id: "msg_a1", role: "user", time: { created: 1000 } });
write(`message/${A}/msg_a2.json`, { id: "msg_a2", role: "assistant", time: { created: 1100 } });
write(`message/${A}/msg_a3.json`, { id: "msg_a3", role: "user", time: { created: 1200 } });
write(`message/${A}/msg_a4.json`, { id: "msg_a4", role: "assistant", time: { created: 1300 } });
// parts (text lives here, not in the message) — plus a non-text part to ignore
write(`part/msg_a1/prt_1.json`, { id: "prt_1", type: "text", text: "add offline sync" });
write(`part/msg_a2/prt_1.json`, { id: "prt_1", type: "reasoning", text: "thinking…" });
write(`part/msg_a2/prt_2.json`, { id: "prt_2", type: "text", text: "here is a plan" });
write(`part/msg_a3/prt_1.json`, { id: "prt_1", type: "text", text: "use IndexedDB not localStorage" });
write(`part/msg_a4/prt_1.json`, { id: "prt_1", type: "text", text: "done, switched to IndexedDB" });

// --- session B: newer, only a title (no messages) -------------------------
const B = "ses_BBBB";
write(`session/${PROJ}/${B}.json`, {
  id: B,
  projectID: PROJ,
  directory: "C:\\proj\\fit",
  title: "Newer session",
  time: { created: 9000, updated: 9000 },
});

// --- session C: a sub-agent session (parentID) → must be skipped ----------
const C = "ses_CCCC";
write(`session/${PROJ}/${C}.json`, {
  id: C,
  projectID: PROJ,
  parentID: A,
  directory: "C:\\proj\\fit",
  title: "sub-agent",
  time: { created: 2000, updated: 2000 },
});

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// --- discovery -------------------------------------------------------------
const list = await new OpenCodeDiscovery(ROOT).list();
check("found 2 top-level sessions (sub-agent skipped)", list.length === 2);
check("sorted newest first (session B)", list[0]?.sessionId === B);
const a = list.find((s) => s.sessionId === A);
check("cwd from session.directory", a?.cwd === "C:\\proj\\fit\\sub");
check("projectCwd from project.worktree", a?.projectCwd === "C:\\proj\\fit");
check("title/summary from session", a?.summary === "Add offline sync" && a?.title === "Add offline sync");
check("assistant turns counted", a?.turns === 2);
check("source = opencode", a?.source === "opencode");
check("not drivable", a?.drivable === false);
check("resumable (storage present)", a?.resumable === true);
check("session B has 0 turns", list.find((s) => s.sessionId === B)?.turns === 0);
check("missing root => []", (await new OpenCodeDiscovery(ROOT + "\\nope").list()).length === 0);

// --- message reader --------------------------------------------------------
const msgs = await readOpenCodeMessages(A, ROOT, -1);
check("read 4 messages", msgs.length === 4);
check("chronological order (first is user prompt)", msgs[0]?.role === "user" && msgs[0]?.text === "add offline sync");
check("assistant text = joined text parts only (no reasoning)", msgs[1]?.text === "here is a plan");
check("last user is the correction", msgs[2]?.text === "use IndexedDB not localStorage");
check("maxMessages tail slice", (await readOpenCodeMessages(A, ROOT, 2)).length === 2);
check("last assistant helper", (await readLastOpenCodeAssistant(A, ROOT)) === "done, switched to IndexedDB");
check("missing session => []", (await readOpenCodeMessages("ses_nope", ROOT, -1)).length === 0);

// --- default root resolves via XDG_DATA_HOME ------------------------------
const prevXdg = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = "C:\\xdg";
check("defaultOpenCodeRoot honors XDG_DATA_HOME", defaultOpenCodeRoot() === path.join("C:\\xdg", "opencode"));
if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
else process.env.XDG_DATA_HOME = prevXdg;

// --- discoverAll merges opencode alongside empty CLI/Desktop roots --------
const merged = await discoverAll(80, ROOT + "\\no-cli", ROOT + "\\no-desktop", ROOT);
check("discoverAll includes opencode sessions", merged.some((s) => s.source === "opencode" && s.sessionId === A));

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[opencode] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
