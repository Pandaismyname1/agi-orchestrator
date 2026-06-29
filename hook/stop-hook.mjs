#!/usr/bin/env node
/**
 * AGI Stop hook — hook-attach mode bridge.
 *
 * Register this as a **Stop hook** in your Claude settings (see
 * src/attach/INTEGRATION.md). It fires when a `claude` session you started by
 * hand finishes a turn. It notifies the running AGI daemon, and if the daemon's
 * local brain decides the session should keep going, it prints a
 * `{"decision":"block","reason":"<next prompt>"}` object to stdout — which makes
 * claude continue with that text as its next instruction. Otherwise it exits
 * silently and claude is allowed to stop.
 *
 * CRITICAL SAFETY PROPERTY: this hook must NEVER block or crash the user's real
 * session. On ANY error (daemon down, bad/timed-out response, parse failure) it
 * exits 0 with no output, which lets claude stop normally.
 *
 * Plain Node ESM (.mjs) — no TypeScript, no build step. Requires Node 18+ for
 * the global `fetch` / `AbortController`.
 */

const DAEMON_URL = process.env.AGI_DAEMON_URL || "http://localhost:4317";
const TIMEOUT_MS = 30_000;

/** Read all of stdin into a string. */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function main() {
  const raw = await readStdin();

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // Can't understand the payload — let claude stop.
    return;
  }

  // Loop guard: if claude is already continuing because of a prior block, do
  // nothing so it can actually stop.
  if (body && body.stop_hook_active) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let result;
  try {
    const res = await fetch(`${DAEMON_URL}/hook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return; // non-2xx → allow stop
    result = await res.json();
  } catch {
    // Network down, timeout, bad JSON — allow stop.
    return;
  } finally {
    clearTimeout(timer);
  }

  // Only continue when the daemon explicitly says so with a usable prompt.
  if (
    result &&
    result.action === "continue" &&
    typeof result.prompt === "string" &&
    result.prompt.trim() !== ""
  ) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: result.prompt }));
  }
  // Otherwise: no output → claude stops.
}

main().catch(() => {
  // Absolute last-resort guard: never throw out of the hook.
  process.exit(0);
});
