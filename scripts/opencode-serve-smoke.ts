/**
 * Live smoke for the OpenCodeSession HTTP-driver prototype. Requires a running
 * `opencode serve` (and, for lmstudio, LM Studio serving the model).
 *
 *   opencode serve --port 4919 --hostname 127.0.0.1
 *   OPENCODE_URL=http://127.0.0.1:4919 npx tsx scripts/opencode-serve-smoke.ts
 *
 * Proves the prototype loop: create session → send message → answer a permission
 * request → read the assistant reply. Auto-approves a bash permission ("once") to
 * exercise the concurrent permission channel; if the model doesn't call a tool,
 * the turn still completes and we just report 0 permissions handled.
 *
 * Env: OPENCODE_URL (default http://127.0.0.1:4919), OPENCODE_PROVIDER
 * (default lmstudio), OPENCODE_MODEL (default qwen/qwen3-coder-30b).
 * Not part of `npm test` — it needs live external services.
 */
import { OpenCodeSession, type OpenCodePermission } from "../src/session/opencodeSession.js";

const baseUrl = process.env.OPENCODE_URL ?? "http://127.0.0.1:4919";
const providerID = process.env.OPENCODE_PROVIDER ?? "lmstudio";
const modelID = process.env.OPENCODE_MODEL ?? "qwen/qwen3-coder-30b";

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await reachable())) {
  console.log(`[opencode-serve] SKIP — no server at ${baseUrl} (start \`opencode serve --port 4919\`).`);
  process.exit(0);
}

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const seenPermissions: OpenCodePermission[] = [];
const session = new OpenCodeSession({
  baseUrl,
  providerID,
  modelID,
  agent: "build",
  title: "agi serve smoke",
  onPermission: (p) => {
    seenPermissions.push(p);
    console.log(`  … permission asked: type=${p.type} title=${p.title ?? ""} → approving once`);
    return "once"; // auto-approve to prove the loop end-to-end
  },
});

try {
  await session.start();
  check("session created", session.sessionId.startsWith("ses_"));
  console.log(`  session id: ${session.sessionId}`);

  const result = await session.runTurn(
    "Use the bash tool to run exactly: echo hello-from-agi . Then reply with the single word DONE.",
  );
  console.log(`  turn took ${(result.durationMs / 1000).toFixed(1)}s, parts=[${result.parts.map((p) => p.type).join(",")}]`);
  console.log(`  assistant: ${result.assistantText.slice(0, 300)}`);

  check("assistant produced text", result.assistantText.length > 0);
  check("turn completed (POST returned)", result.durationMs > 0);
  // Permission handling is best-effort: only asserted if the model actually called a tool.
  if (seenPermissions.length > 0) {
    check("permission loop exercised (approved a request)", result.permissionsHandled >= 1);
  } else {
    console.log("  note: model did not request a tool permission this run (loop wired, not exercised)");
  }
} finally {
  await session.dispose();
}

console.log(`\n[opencode-serve] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
