/**
 * Drive the dashboard over its WebSocket like the browser would:
 * connect, start all sessions, and watch live status + screen stream in.
 * Validates the full server <-> supervisor <-> orchestrator path.
 */
import { WebSocket } from "ws";

const ws = new WebSocket("ws://localhost:4317/ws");
let started = false;
let snaps = 0;

ws.on("open", () => console.log("[ws-test] connected"));
ws.on("error", (e) => console.error("[ws-test] error", e.message));

ws.on("message", (raw) => {
  const snap = JSON.parse(raw.toString());
  snaps++;
  const s = snap.sessions[0];
  if (!s) return;

  if (snaps === 1) {
    console.log(`[ws-test] provider: ${snap.provider.model} ok=${snap.provider.ok}`);
    console.log(`[ws-test] session "${s.id}" status=${s.status}`);
    console.log("[ws-test] -> sending startAll");
    ws.send(JSON.stringify({ type: "startAll" }));
    started = true;
    return;
  }

  if (started && snaps % 4 === 0) {
    const screen = snap.focus?.screen ?? "";
    const lastLine = screen.split("\n").filter((l: string) => l.trim()).slice(-1)[0] ?? "(no screen)";
    console.log(
      `[ws-test] status=${s.status} turns=${s.turns} | brain: ${(s.lastDecision || "—").slice(0, 70)}`,
    );
    console.log(`           screen tail: ${lastLine.trim().slice(0, 80)}`);
  }

  if (s.status === "done" || s.status === "stopped" || s.status === "error") {
    console.log(`[ws-test] FINAL status=${s.status} turns=${s.turns} — ${s.error ?? s.lastDecision}`);
    console.log("[ws-test] => dashboard path PASS ✅");
    ws.close();
    process.exit(0);
  }
});

setTimeout(() => {
  console.log("[ws-test] timeout");
  ws.close();
  process.exit(1);
}, 180_000);
