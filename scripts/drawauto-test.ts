/**
 * Deterministic tests for the workflow draw-to-create automation helpers
 * (web/src/lib/drawauto.ts). Pure — no DOM. Verifies default events, the rule
 * shape a drawn edge produces, and event-aware naming.
 */
import {
  DRAW_EVENTS,
  defaultEventFor,
  eventPhrase,
  buildDrawnAutomation,
} from "../web/src/lib/drawauto.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── defaults / catalog ──────────────────────────────────────────────────────────
check("start defaults to done", defaultEventFor("start") === "done");
check("stop defaults to error", defaultEventFor("stop") === "error");
check("DRAW_EVENTS lists all five lifecycle events", DRAW_EVENTS.length === 5 && DRAW_EVENTS[0] === "done");
check("eventPhrase covers every draw event", DRAW_EVENTS.every((e) => eventPhrase(e).length > 0));

// ── buildDrawnAutomation (rule shape) ───────────────────────────────────────────
const r = buildDrawnAutomation({ from: "api", to: "deploy", kind: "start", event: "done", fromLabel: "API", toLabel: "Deploy" });
check("scoped to the firing session via match.sessionId", r.match?.sessionId === "api");
check("triggers on the chosen event", JSON.stringify(r.on) === JSON.stringify(["done"]));
check("single action with kind + target", r.actions!.length === 1 && r.actions![0]!.kind === "start" && (r.actions![0] as { target: string }).target === "deploy");
check("enabled by default", r.enabled === true);
check("name uses labels + event phrase", r.name === "Start Deploy when API is done");

// honours a non-default event (the whole point of the picker)
const r2 = buildDrawnAutomation({ from: "a", to: "b", kind: "stop", event: "rate-limited" });
check("stop on a picked event", JSON.stringify(r2.on) === JSON.stringify(["rate-limited"]));
check("name falls back to ids and reflects the event", r2.name === "Stop b when a is rate-limited");
check("stop action targets b", r2.actions![0]!.kind === "stop" && (r2.actions![0] as { target: string }).target === "b");

console.log(`\n[drawauto] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
