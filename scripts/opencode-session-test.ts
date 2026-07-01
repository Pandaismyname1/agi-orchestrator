/**
 * Deterministic test for the OpenCodeSession HTTP driver — no server, no model.
 * A mock `fetch` stands in for `opencode serve`: it creates a session, exposes a
 * fake `/event` SSE stream, and — when the turn's message POST arrives — injects a
 * `permission.updated` event into that stream, then resolves the turn once the
 * driver has answered the permission. This proves the create → send → permission
 * loop (the concurrent permission channel that unblocks a turn) end to end.
 */
import { OpenCodeSession, type OpenCodePermission } from "../src/session/opencodeSession.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const enc = new TextEncoder();
const calls: Array<{ url: string; method: string; body?: unknown }> = [];
let eventController: ReadableStreamDefaultController<Uint8Array> | null = null;

/** Emit one SSE frame into the fake /event stream. */
function emit(evt: unknown): void {
  eventController?.enqueue(enc.encode(`data: ${JSON.stringify(evt)}\n\n`));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mockFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(init.body as string) : undefined;
  calls.push({ url, method, body });

  // Create session.
  if (url.endsWith("/session") && method === "POST") {
    return new Response(JSON.stringify({ id: "ses_test", title: "t" }), {
      headers: { "content-type": "application/json" },
    });
  }

  // Persistent event stream — capture the controller so the turn can inject events.
  if (url.endsWith("/event")) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        eventController = controller;
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`));
        // Respect dispose()'s abort like the real server: closing the stream ends
        // the driver's read loop so dispose() settles.
        init?.signal?.addEventListener("abort", () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }

  // Answer a permission — record it and ack.
  if (url.includes("/permission/") && method === "POST") {
    return new Response(JSON.stringify(true), { headers: { "content-type": "application/json" } });
  }

  // The turn: block until the driver answers the permission we inject, mirroring
  // how the real server holds the message POST open while awaiting approval.
  if (url.endsWith("/message") && method === "POST") {
    emit({
      type: "permission.updated",
      properties: { id: "perm_1", sessionID: "ses_test", type: "bash", title: "echo hi" },
    });
    // Wait until the driver has POSTed the permission response.
    for (let i = 0; i < 100; i++) {
      if (calls.some((c) => c.url.includes("/permission/perm_1") && c.method === "POST")) break;
      await sleep(5);
    }
    return new Response(
      JSON.stringify({
        info: { id: "msg_1", role: "assistant" },
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", tool: "bash" },
          { type: "text", text: "hello-from-agi\nDONE" },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }

  // Abort (dispose).
  if (url.endsWith("/abort")) return new Response("{}", { headers: { "content-type": "application/json" } });

  return new Response("{}", { status: 200 });
}) as typeof fetch;

const seen: OpenCodePermission[] = [];
const session = new OpenCodeSession({
  baseUrl: "http://mock",
  providerID: "lmstudio",
  modelID: "qwen/qwen3-coder-30b",
  agent: "build",
  fetchImpl: mockFetch,
  onPermission: (p) => {
    seen.push(p);
    return "once";
  },
});

await session.start();
check("session created from POST /session", session.sessionId === "ses_test");

const result = await session.runTurn("Run echo hello-from-agi then say DONE");

// message POST shape
const msgCall = calls.find((c) => c.url.endsWith("/message") && c.method === "POST");
const b = msgCall?.body as { model?: { providerID?: string; modelID?: string }; agent?: string; parts?: Array<{ type: string; text: string }> } | undefined;
check("message POST sent model provider+id", b?.model?.providerID === "lmstudio" && b?.model?.modelID === "qwen/qwen3-coder-30b");
check("message POST sent agent", b?.agent === "build");
check("message POST sent text part", b?.parts?.[0]?.type === "text" && b?.parts?.[0]?.text?.includes("echo hello-from-agi") === true);

// permission loop
check("onPermission called with injected request", seen.length === 1 && seen[0]?.id === "perm_1" && seen[0]?.type === "bash");
const permCall = calls.find((c) => c.url.includes("/permission/perm_1") && c.method === "POST");
check("driver POSTed to /session/ses_test/permission/perm_1", permCall?.url.endsWith("/session/ses_test/permission/perm_1") === true);
check("permission response body was the policy decision", (permCall?.body as { response?: string })?.response === "once");
check("permissionsHandled counted", result.permissionsHandled === 1);

// assistant text extraction (text parts only, tool/reasoning excluded)
check("assistantText = joined text parts only", result.assistantText === "hello-from-agi\nDONE");
check("parts include tool+reasoning+text", result.parts.map((p) => p.type).join(",") === "reasoning,tool,text");

await session.dispose();
check("dispose aborted the session", calls.some((c) => c.url.endsWith("/session/ses_test/abort") && c.method === "POST"));

console.log(`\n[opencode-session] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
