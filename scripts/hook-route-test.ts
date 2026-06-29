/**
 * Feature 4 route test: register an attached session, then POST a real hook
 * body and confirm the daemon drives it via the real brain + real transcript.
 * Server must be running on :4317.
 */
export {};
const BASE = "http://localhost:4317";
const sessionId = "40a3602d-542b-461e-a73c-fced4d778329";
const cwd = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\demo";

async function post(path: string, body: unknown) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

console.log("[hook-route] register:", await post("/attach", { session_id: sessionId, goal: "Files exist; if both haiku.txt and README.md are present, you are done.", doneCriteria: "both files exist" }));

const d1 = await post("/hook", { session_id: sessionId, cwd, stop_hook_active: false });
console.log("[hook-route] /hook decision:", d1);

const d2 = await post("/hook", { session_id: sessionId, cwd, stop_hook_active: true });
console.log("[hook-route] /hook (loop guard):", d2);

const ok =
  d1 && (d1 as any).action && (d2 as any).reason?.includes("loop guard");
console.log(`[hook-route] => ${ok ? "PASS ✅ (real brain decision + loop guard via wired route)" : "FAIL ⚠️"}`);
process.exit(ok ? 0 : 1);
