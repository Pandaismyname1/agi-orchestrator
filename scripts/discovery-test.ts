/**
 * Deterministic test for SessionDiscovery: seed a fake ~/.claude/projects tree
 * and verify it extracts cwd, summary, turn count, and recency order. No claude.
 */
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { SessionDiscovery } from "../src/discovery.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\disc-root";
rmSync(ROOT, { recursive: true, force: true });
const projDir = `${ROOT}\\C--proj-a`;
mkdirSync(projDir, { recursive: true });

const lines = (cwd: string, firstUser: string, assistants: string[]) =>
  [
    JSON.stringify({ type: "user", cwd, message: { role: "user", content: [{ type: "text", text: firstUser }] } }),
    ...assistants.map((a) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: a }] } })),
  ].join("\n");

writeFileSync(`${projDir}\\11111111-1111-1111-1111-111111111111.jsonl`, lines("C:\\proj\\a", "Build the API", ["did 1", "did 2"]));
writeFileSync(`${projDir}\\22222222-2222-2222-2222-222222222222.jsonl`, lines("C:\\proj\\b", "Write the docs", ["wrote intro"]));

// make session 2 newer so it sorts first
const now = Date.now() / 1000;
utimesSync(`${projDir}\\11111111-1111-1111-1111-111111111111.jsonl`, now - 100, now - 100);
utimesSync(`${projDir}\\22222222-2222-2222-2222-222222222222.jsonl`, now, now);

let pass = true;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); if (!c) pass = false; };

const list = await new SessionDiscovery(ROOT).list();
check("found 2 sessions", list.length === 2);
check("sorted newest first (session 2)", list[0]?.sessionId.startsWith("22222222") ?? false);
const a = list.find((s) => s.sessionId.startsWith("11111111"));
check("cwd parsed from transcript", a?.cwd === "C:\\proj\\a");
check("summary = first user msg", a?.summary === "Build the API");
check("assistant turns counted", a?.turns === 2);
check("session 2 has 1 turn", list.find((s) => s.sessionId.startsWith("22222222"))?.turns === 1);
check("missing root => []", (await new SessionDiscovery(ROOT + "\\nope").list()).length === 0);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[discovery] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
