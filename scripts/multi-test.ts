/**
 * Feature 1 capstone: drive TWO sessions concurrently via the dashboard WS and
 * confirm they run in parallel and both complete. Server must be on :4317.
 */
import { WebSocket } from "ws";

const ws = new WebSocket("ws://localhost:4317/ws");
const seenRunning = new Set<string>();
let everConcurrent = false;
let started = false;

ws.on("open", () => console.log("[multi] connected"));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type !== "snapshot") return;
  const sessions: any[] = m.sessions;

  if (!started) {
    console.log("[multi] sessions:", sessions.map((s) => s.id).join(", "), "→ startAll");
    ws.send(JSON.stringify({ type: "startAll" }));
    started = true;
    return;
  }

  const running = sessions.filter((s) => s.status === "running").map((s) => s.id);
  running.forEach((id) => seenRunning.add(id));
  if (running.length >= 2) everConcurrent = true;

  const terminal = (s: any) => ["done", "stopped", "error"].includes(s.status);
  const line = sessions.map((s) => `${s.id}:${s.status}/t${s.turns}`).join("  ");
  console.log(`[multi] ${line}${everConcurrent ? "  [concurrent✓]" : ""}`);

  if (sessions.length > 0 && sessions.every(terminal)) {
    const allDone = sessions.every((s) => s.status === "done");
    console.log(`\n[multi] FINAL: ${sessions.map((s) => `${s.id}=${s.status}`).join(", ")}`);
    console.log(`[multi] ran concurrently: ${everConcurrent}`);
    console.log(`[multi] => ${allDone && everConcurrent ? "PASS ✅ (2 sessions in parallel, both done)" : "see results ⚠️"}`);
    ws.close();
    process.exit(allDone && everConcurrent ? 0 : 1);
  }
});

setTimeout(() => { console.log("[multi] timeout"); ws.close(); process.exit(1); }, 240_000);
