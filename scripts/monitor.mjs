/**
 * Long-run session monitor (background). Watches ONE session over the WS, logs
 * state transitions, and EXITS — which re-invokes the supervising agent — on a
 * checkpoint interval OR any critical condition. On a clear runaway/spin it also
 * STOPS the session itself to protect the subscription.
 *
 *   node scripts/monitor.mjs <sessionId> <checkpointSeconds>
 *
 * Loopback is trusted by the dashboard (trustLocal), so no token is needed.
 * Reads/creates .scratch/monitor-state.json {startedAt} to track the 3h window.
 */
import WebSocket from "../node_modules/ws/index.js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";

const SID = process.argv[2] || "8f037eb1-ea00-4ee5-a98b-fe11d5c5c8e5";
const CHECKPOINT_MS = (Number(process.argv[3]) || 1200) * 1000;
const STATE = "C:/Users/panda/Desktop/AGI/.scratch/monitor-state.json";
const LOG = "C:/Users/panda/Desktop/AGI/.scratch/monitor.log";
const TOTAL_MS = 3 * 60 * 60 * 1000; // 3h target

// First-launch start time (persisted so it survives re-invocations).
let startedAt = Date.now();
if (existsSync(STATE)) {
  try {
    startedAt = JSON.parse(readFileSync(STATE, "utf8")).startedAt || startedAt;
  } catch {}
}
writeFileSync(STATE, JSON.stringify({ startedAt }));

const now = () => new Date().toISOString().slice(11, 19);
const log = (s) => {
  const line = `${now()} ${s}`;
  appendFileSync(LOG, line + "\n");
  console.log(line);
};
const elapsedMin = () => Math.round((Date.now() - startedAt) / 60000);

let latest = null;
let lastConnAt = Date.now();
const samples = []; // rolling {t, status, turns, decision, reply}

function finish(reason, detail) {
  log(`EXIT reason=${reason} elapsedMin=${elapsedMin()} ${detail || ""}`);
  try {
    writeFileSync(
      "C:/Users/panda/Desktop/AGI/.scratch/monitor-exit.json",
      JSON.stringify({ reason, detail: detail || "", elapsedMin: elapsedMin(), at: Date.now() }, null, 2),
    );
  } catch {}
  process.exit(0);
}

function stopSession(ws) {
  try {
    ws.send(JSON.stringify({ type: "stop", id: SID }));
    log(`>>> sent STOP to ${SID.slice(0, 8)}`);
  } catch {}
}

let ws;
function connect() {
  ws = new WebSocket("ws://localhost:4317/ws");
  ws.on("open", () => {
    lastConnAt = Date.now();
    log("ws connected");
  });
  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (m.type === "snapshot") {
      lastConnAt = Date.now();
      latest = (m.sessions || []).find((s) => s.id === SID) || null;
    }
  });
  ws.on("close", () => setTimeout(connect, 2000));
  ws.on("error", () => {});
}
connect();

// Sample + evaluate every 30s.
setInterval(() => {
  // Server/WS down for > 2 min → critical (server crash).
  if (Date.now() - lastConnAt > 120000) finish("WS_DOWN", "no snapshot for >2min — server may have crashed");

  if (!latest) {
    log("(no session in snapshot yet)");
  } else {
    const s = latest;
    const decision = (s.lastDecision || "").slice(0, 90);
    const reply = (s.lastReply || "").slice(0, 60);
    samples.push({ t: Date.now(), status: s.status, turns: s.turns, decision, reply });
    if (samples.length > 12) samples.shift();
    log(`status=${s.status} turns=${s.turns} dec="${decision}" ${s.error ? "ERR=" + s.error.slice(0, 80) : ""}`);

    // --- critical conditions ---
    if (s.status === "error") finish("ERROR", s.error || "session entered error state");

    // Needs-input that persists (autonomous session shouldn't, but a dangerous
    // gate can pause it) — wake the supervisor to resolve it.
    const needIn = samples.filter((x) => x.status === "needs-input").length;
    if (s.status === "needs-input" && needIn >= 4) finish("NEEDS_INPUT", `paused on a decision/gate ~${needIn * 0.5}min`);

    // Runaway / spin: many turns advancing in a short window with a repeating
    // reply → the spin-loop regressed. Protect the subscription: stop + wake me.
    if (samples.length >= 10) {
      const win = samples.slice(-10); // ~5 min
      const turnDelta = win[win.length - 1].turns - win[0].turns;
      const distinctReplies = new Set(win.map((x) => x.reply)).size;
      const distinctDecisions = new Set(win.map((x) => x.decision)).size;
      if (turnDelta >= 6 && distinctReplies <= 2 && distinctDecisions <= 3) {
        stopSession(ws);
        finish("CRITICAL_SPIN", `${turnDelta} turns/5min with repeating reply — auto-stopped`);
      }
    }
  }

  if (Date.now() - startedAt >= TOTAL_MS) finish("DONE_3H", "reached the 3-hour target");
}, 30000);

// Checkpoint: exit after the interval so the supervisor reviews + relaunches.
setTimeout(() => finish("CHECKPOINT", `routine ${Math.round(CHECKPOINT_MS / 60000)}min checkpoint`), CHECKPOINT_MS);

log(`monitor started: session=${SID.slice(0, 8)} checkpoint=${CHECKPOINT_MS / 1000}s elapsedMin=${elapsedMin()}`);
