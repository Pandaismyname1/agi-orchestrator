/**
 * Feature 2 test: add / update / remove a session over the dashboard WS, and
 * confirm it persists to config.json. Server must be running on :4317.
 */
import { WebSocket } from "ws";
import { readFile } from "node:fs/promises";

const ws = new WebSocket("ws://localhost:4317/ws");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let snap: any = null;
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "snapshot") snap = m;
  if (m.type === "error") console.log("[crud] server error:", m.message);
});

const send = (o: unknown) => ws.send(JSON.stringify(o));
const ids = () => (snap?.sessions ?? []).map((s: any) => s.id);
async function configIds() {
  const c = JSON.parse(await readFile("config.json", "utf8"));
  return c.sessions.map((s: any) => s.id);
}

await new Promise((r) => ws.on("open", r));
await sleep(1200);
console.log("[crud] initial sessions:", ids());

const NEW = "crud-temp";
send({ type: "add", session: { id: NEW, cwd: "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\proj-a", goal: "temp goal", doneCriteria: "temp done", permissionMode: "acceptEdits" } });
await sleep(1500);
const added = ids().includes(NEW) && (await configIds()).includes(NEW);
console.log(`[crud] add: ${added ? "ok" : "FAIL"} — sessions now ${ids()}`);

send({ type: "update", id: NEW, patch: { goal: "updated goal!" } });
await sleep(1500);
const c = JSON.parse(await readFile("config.json", "utf8"));
const updated = c.sessions.find((s: any) => s.id === NEW)?.goal === "updated goal!";
console.log(`[crud] update: ${updated ? "ok" : "FAIL"} — persisted goal = "${c.sessions.find((s: any) => s.id === NEW)?.goal}"`);

send({ type: "remove", id: NEW });
await sleep(1500);
const removed = !ids().includes(NEW) && !(await configIds()).includes(NEW);
console.log(`[crud] remove: ${removed ? "ok" : "FAIL"} — sessions now ${ids()}`);

const pass = added && updated && removed;
console.log(`[crud] => ${pass ? "PASS ✅ (add/update/remove persisted to config.json)" : "FAIL ⚠️"}`);
ws.close();
process.exit(pass ? 0 : 1);
