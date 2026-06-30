/**
 * Deterministic test for AttachManager observability: the turn counter, the
 * dashboard `list()` view, last-activity/last-decision tracking, and detach.
 * Uses a stub brain + readLastMessage + an injected fake clock — NO network.
 */
import {
  AttachManager,
  type AttachBrain,
  type ReadLastMessage,
} from "../src/attach/attachManager.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// Fake clock — advances 1000ms per read so timestamps are distinct & ordered.
let clock = 1_000_000;
const now = () => (clock += 1000);

// Brain: continue twice, then a needs-input stop (escalation), then a plain stop.
let brainCalls = 0;
const stubBrain: AttachBrain = async () => {
  brainCalls++;
  if (brainCalls <= 2) return { action: "continue", prompt: "next step", reason: `continue #${brainCalls}` };
  if (brainCalls === 3) return { action: "stop", reason: "needs your decision: X or Y?", needsInput: true };
  return { action: "stop", reason: "done" };
};
const stubRead: ReadLastMessage = async () => "canned last message";

const mgr = new AttachManager({
  brain: stubBrain,
  readLastMessage: stubRead,
  limits: { maxTurns: 50, maxWallClockMin: 120, pingPongThreshold: 3 },
  now,
});

const SID = "11111111-2222-3333-4444-555555555555";

// ---- register seeds a view with zero turns ---------------------------------
mgr.register(SID, { goal: "GOAL", doneCriteria: "DONE" });
let view = mgr.list();
check("list() has the registered session", view.length === 1 && view[0]?.sessionId === SID);
check("turns start at 0", view[0]?.turns === 0);
check("no lastActivity before first turn", view[0]?.lastActivity === undefined);
check("registeredAt is set from the clock", typeof view[0]?.registeredAt === "number");

// ---- a continue advances the turn counter + records activity ----------------
const body = { session_id: SID, cwd: "C:/x" };
await mgr.handle(body);
view = mgr.list();
check("turns = 1 after a continue", view[0]?.turns === 1);
check("lastAction is continue", view[0]?.lastAction === "continue");
check("lastReason captured", view[0]?.lastReason === "continue #1");
check("lastActivity is set after a turn", typeof view[0]?.lastActivity === "number");
const firstActivity = view[0]?.lastActivity ?? 0;

await mgr.handle(body);
view = mgr.list();
check("turns = 2 after a second continue", view[0]?.turns === 2);
check("lastActivity advanced", (view[0]?.lastActivity ?? 0) > firstActivity);

// ---- an escalation stop flags needsInput, doesn't advance turns -------------
await mgr.handle(body); // brainCalls === 3 → needs-input stop
view = mgr.list();
check("turns stays 2 on a stop decision", view[0]?.turns === 2);
check("lastAction is stop", view[0]?.lastAction === "stop");
check("escalation sets needsInput", view[0]?.needsInput === true);

// ---- a later non-escalation decision clears needsInput ----------------------
await mgr.handle(body); // brainCalls === 4 → plain stop
check("a plain stop clears needsInput", mgr.list()[0]?.needsInput === false);

// ---- an unregistered session never appears in the view ----------------------
await mgr.handle({ session_id: "ghost", cwd: "C:/x" });
check("ghost session is not listed", mgr.list().every((v) => v.sessionId !== "ghost"));

// ---- detach (unregister) removes it from the view ---------------------------
mgr.unregister(SID);
check("detach removes the session from list()", mgr.list().length === 0);
check("isRegistered is false after detach", !mgr.isRegistered(SID));

// ---- list() sorts newest-registered first -----------------------------------
const A = "aaaaaaaa-0000-0000-0000-000000000000";
const B = "bbbbbbbb-0000-0000-0000-000000000000";
mgr.register(A, { goal: "a", doneCriteria: "a" }); // registered earlier
mgr.register(B, { goal: "b", doneCriteria: "b" }); // registered later
const order = mgr.list();
check("newest-registered session sorts first", order[0]?.sessionId === B && order[1]?.sessionId === A);

console.log(`\n[attach] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
