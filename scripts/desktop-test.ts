/**
 * Deterministic test for Claude DESKTOP session discovery + the CLI∪Desktop
 * merge — no real Claude data. Seeds a fake Desktop descriptor tree and a fake
 * CLI ~/.claude/projects store and asserts: descriptors → sessions (skipping
 * those with no cliSessionId), resumable reflects transcript presence, titles +
 * projectCwd carry through, and discoverAll dedupes a session that's in both.
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { DesktopDiscovery, discoverAll } from "../src/discovery.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\desktop-test";
rmSync(ROOT, { recursive: true, force: true });
const CLI = `${ROOT}\\cli-projects`;
const DESK = `${ROOT}\\desktop-sessions`;
mkdirSync(`${CLI}\\proj-eve`, { recursive: true });
mkdirSync(`${DESK}\\outer\\inner`, { recursive: true });

const ID_A = "11111111-1111-1111-1111-111111111111"; // desktop + has transcript
const ID_B = "22222222-2222-2222-2222-222222222222"; // desktop, NO transcript (archived)
const ID_C = "33333333-3333-3333-3333-333333333333"; // CLI-only

const transcript = (cwd: string, user: string) =>
  [
    JSON.stringify({ type: "user", cwd, message: { role: "user", content: [{ type: "text", text: user }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
  ].join("\n");

writeFileSync(`${CLI}\\proj-eve\\${ID_A}.jsonl`, transcript("C:\\proj\\eve", "Fix the bug"));
writeFileSync(`${CLI}\\proj-eve\\${ID_C}.jsonl`, transcript("C:\\proj\\eve", "Add tests"));

const descriptor = (o: Record<string, unknown>) => JSON.stringify(o);
writeFileSync(
  `${DESK}\\outer\\inner\\local_a.json`,
  descriptor({ cliSessionId: ID_A, cwd: "C:\\proj\\eve", originCwd: "C:\\proj\\eve", title: "Fix the bug", lastActivityAt: 2000 }),
);
writeFileSync(
  `${DESK}\\outer\\inner\\local_b.json`,
  descriptor({ cliSessionId: ID_B, cwd: "C:\\proj\\eve\\.claude\\worktrees\\w1", originCwd: "C:\\proj\\eve", title: "Old archived run", isArchived: true, lastActivityAt: 1000 }),
);
writeFileSync(`${DESK}\\outer\\inner\\local_u.json`, descriptor({ cliSessionId: "undefined", title: "no cli session" }));

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const desk = await new DesktopDiscovery(DESK, CLI).list();
check("lists only descriptors with a cliSessionId (2, not 3)", desk.length === 2);
const a = desk.find((s) => s.sessionId === ID_A);
const b = desk.find((s) => s.sessionId === ID_B);
check("desktop session A is present", !!a);
check("A carries its title", a?.title === "Fix the bug");
check("A is resumable (transcript exists)", a?.resumable === true);
check("A source = desktop", a?.source === "desktop");
check("B is NOT resumable (no transcript)", b?.resumable === false);
check("B projectCwd = originCwd (not the worktree)", b?.projectCwd === "C:\\proj\\eve");
check("the 'undefined' descriptor is skipped", !desk.some((s) => s.title === "no cli session"));

const all = await discoverAll(80, CLI, DESK);
const ids = new Set(all.map((s) => s.sessionId));
check("merge includes the CLI-only session C", ids.has(ID_C));
check("merge includes desktop A and B", ids.has(ID_A) && ids.has(ID_B));
const mergedA = all.find((s) => s.sessionId === ID_A);
check("A appears ONCE (deduped across CLI+Desktop)", all.filter((s) => s.sessionId === ID_A).length === 1);
check("merged A keeps the desktop title + source", mergedA?.title === "Fix the bug" && mergedA?.source === "desktop");
check("CLI-only C has source cli", all.find((s) => s.sessionId === ID_C)?.source === "cli");

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[desktop] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
