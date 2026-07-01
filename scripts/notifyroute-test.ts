/**
 * Deterministic test for per-session notification overrides (policy/notifyroute).
 * Pure functions — no LLM, no network, no disk.
 */
import {
  sessionNotifies,
  normalizeNotifyOverride,
  isNotifyEvent,
  NOTIFY_EVENTS,
} from "../src/policy/notifyroute.js";
import type { WebhookEvent } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// --- sessionNotifies -------------------------------------------------------
check("no override → all events notify", sessionNotifies(undefined, "done") && sessionNotifies(undefined, "error"));
check("mute → nothing notifies", !sessionNotifies({ mute: true }, "done") && !sessionNotifies({ mute: true }, "error"));
check("mute wins over an event list", !sessionNotifies({ mute: true, events: ["error"] }, "error"));
check("empty events list → all notify (not a deny-all)", sessionNotifies({ events: [] }, "done"));
check("allow-list: listed event notifies", sessionNotifies({ events: ["error"] }, "error"));
check("allow-list: unlisted event suppressed", !sessionNotifies({ events: ["error"] }, "done"));
check(
  "allow-list of two: both fire, others don't",
  sessionNotifies({ events: ["error", "done"] }, "done") &&
    sessionNotifies({ events: ["error", "done"] }, "error") &&
    !sessionNotifies({ events: ["error", "done"] }, "stopped"),
);

// every canonical event is honored when allow-listed
for (const e of NOTIFY_EVENTS) {
  check(`allow-list of just "${e}" fires "${e}"`, sessionNotifies({ events: [e] }, e));
}

// --- isNotifyEvent ---------------------------------------------------------
check("isNotifyEvent accepts known events", NOTIFY_EVENTS.every(isNotifyEvent));
check("isNotifyEvent rejects junk", !isNotifyEvent("nope") && !isNotifyEvent(3) && !isNotifyEvent(undefined));

// --- normalizeNotifyOverride ----------------------------------------------
check("normalize: undefined → undefined", normalizeNotifyOverride(undefined) === undefined);
check("normalize: empty object → undefined", normalizeNotifyOverride({}) === undefined);
check("normalize: {mute:false} alone → undefined", normalizeNotifyOverride({ mute: false }) === undefined);
check("normalize: {mute:true} → {mute:true}", JSON.stringify(normalizeNotifyOverride({ mute: true })) === JSON.stringify({ mute: true }));

const n1 = normalizeNotifyOverride({ events: ["error", "done"] });
check("normalize: keeps canonical event order (done before error)", JSON.stringify(n1) === JSON.stringify({ events: ["done", "error"] }));

const n2 = normalizeNotifyOverride({ events: ["error", "error", "bogus", "done"] as WebhookEvent[] });
check("normalize: dedupes + drops unknown events", JSON.stringify(n2) === JSON.stringify({ events: ["done", "error"] }));

const n3 = normalizeNotifyOverride({ mute: true, events: ["error"] });
check("normalize: mute + events keeps both", JSON.stringify(n3) === JSON.stringify({ mute: true, events: ["error"] }));

check("normalize: only-unknown events → undefined", normalizeNotifyOverride({ events: ["nope"] as unknown[] }) === undefined);
check("normalize: non-object input → undefined", normalizeNotifyOverride(42) === undefined && normalizeNotifyOverride("x") === undefined);

// --- round-trip: a normalized override drives sessionNotifies correctly -----
const rt = normalizeNotifyOverride({ events: ["error"] })!;
check("round-trip: normalized allow-list suppresses others", sessionNotifies(rt, "error") && !sessionNotifies(rt, "done"));

console.log(`\n[notifyroute] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
