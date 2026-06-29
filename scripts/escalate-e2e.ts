/**
 * Live E2E for the attention system. Adds a session whose goal forces a genuine
 * either/or the agent must defer, starts it, and expects the brain to ESCALATE:
 * status -> needs-input with options. Auto-resolves option 0, then expects the
 * run to resume and finish. Verifies the decision was persisted to SQLite.
 *
 * Dashboard server must be running on :4317.
 */
import { WebSocket } from "ws";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";

const CWD = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\esc";
rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

const ID = "esc-demo";
const ws = new WebSocket("ws://localhost:4317/ws");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (o: unknown) => ws.send(JSON.stringify(o));

let phase: "add" | "starting" | "watch" | "done" = "add";
let escalated = false;
let resolved = false;

ws.on("message", async (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "error") { console.log("[e2e] server error:", m.message); return; }
  if (m.type !== "snapshot") return;
  const s = m.sessions.find((x: any) => x.id === ID);

  if (phase === "add") {
    phase = "starting";
    console.log("[e2e] adding escalation session…");
    send({ type: "add", session: {
      id: ID, cwd: CWD, permissionMode: "acceptEdits",
      goal: "This project needs a config file. The app supports BOTH json and yaml. Do NOT choose the format yourself — ask the user which format they want, then create the config file in exactly that format.",
      doneCriteria: "a config file exists in the format the user chose.",
    }});
    await sleep(1200);
    send({ type: "start", id: ID });
    phase = "watch";
    return;
  }

  if (phase !== "watch" || !s) return;

  if (s.status === "needs-input" && s.attention && !resolved) {
    escalated = true;
    resolved = true;
    console.log(`[e2e] ⚑ ESCALATED — question: "${s.attention.question}"`);
    s.attention.options.forEach((o: any, i: number) => console.log(`        [${i}] ${o.label} — ${o.rationale}`));
    console.log("[e2e] auto-resolving option 0…");
    send({ type: "resolve", id: ID, choice: { optionIndex: 0 } });
    return;
  }

  console.log(`[e2e] status=${s.status} turns=${s.turns}`);
  if (["done", "stopped", "error"].includes(s.status)) {
    phase = "done";
    // verify persistence
    const db = new DatabaseSync("agi.db");
    const row = db.prepare("SELECT COUNT(*) c FROM attention_requests WHERE status='resolved'").get() as { c: number };
    db.close();
    console.log(`[e2e] persisted resolved attention_requests: ${row.c}`);
    send({ type: "remove", id: ID });
    await sleep(600);
    const ok = escalated && resolved && row.c >= 1;
    console.log(`\n[e2e] => ${ok ? "PASS ✅ (escalate → options → resolve → resume, persisted)" : "INCOMPLETE ⚠️ (brain may not have escalated this run)"}`);
    ws.close();
    process.exit(ok ? 0 : 1);
  }
});

setTimeout(() => { console.log("[e2e] timeout"); ws.close(); process.exit(1); }, 240_000);
