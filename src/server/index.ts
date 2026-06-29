/**
 * Dashboard server — HTTP (serves the single-page UI) + WebSocket (live state).
 *
 * Boot: preflight (billing safety) → config → LLM health → start server.
 * Sessions are NOT auto-started; you start/stop them from the dashboard.
 *
 *   npm run dashboard   →   http://localhost:<port>
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { preflight, BillingSafetyError } from "../util/env.js";
import { loadConfig } from "../config.js";
import { Supervisor } from "./supervisor.js";
import { openStore } from "../db/store.js";
import { AttachManager } from "../attach/attachManager.js";
import { decideNextStep } from "../brain/decide.js";
import { LocalLLM } from "../brain/provider.js";
import { readLastAssistantMessage } from "../transcript/reader.js";
import type { SessionConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUSH_MS = 1000;

interface SessionInput {
  id?: string;
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode?: SessionConfig["permissionMode"];
  autonomy?: SessionConfig["autonomy"];
}

type SessionPatch = Partial<{
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode: SessionConfig["permissionMode"];
  autonomy: SessionConfig["autonomy"];
}>;

interface ClientMsg {
  type: "start" | "stop" | "startAll" | "focus" | "add" | "update" | "remove" | "resolve";
  id?: string;
  session?: SessionInput;
  patch?: SessionPatch;
  /** For "resolve": how the user answered an open human-decision. */
  choice?: { optionIndex?: number; customPrompt?: string; stop?: boolean };
}

async function main(): Promise<void> {
  try {
    preflight();
  } catch (e) {
    if (e instanceof BillingSafetyError) {
      console.error(`\n🛑 BILLING SAFETY:\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const cfg = await loadConfig();
  const store = openStore(cfg.dbPath ?? "agi.db");
  console.log(`persistent store → ${cfg.dbPath}`);
  const sup = new Supervisor(cfg, store);

  const health = await sup.health();
  console.log(`local LLM @ ${cfg.provider.baseUrl} (${cfg.provider.model}): ${health.detail}`);
  if (!health.ok) {
    console.error(`⚠ local model not ready — sessions will fail until it's loaded.`);
  }

  // Hook-attach mode: drive a `claude` the user started by hand. The Stop hook
  // POSTs to /hook; we decide via the same local brain and return a decision.
  const llm = new LocalLLM(cfg.provider);
  const attach = new AttachManager({
    brain: async ({ goal, doneCriteria, lastAssistantText, turnNumber }) => {
      const session: SessionConfig = { id: "attached", cwd: "", goal, doneCriteria };
      const d = await decideNextStep(llm, session, lastAssistantText, turnNumber);
      // Attached sessions are hand-driven in the user's own terminal — there's no
      // dashboard pause/resume here, so a genuine decision just hands control back.
      if (d.action === "escalate") {
        return { action: "stop", reason: `needs your decision: ${d.question ?? d.reason}` };
      }
      return { action: d.action, prompt: d.prompt, reason: d.reason };
    },
    readLastMessage: (cwd, sessionId) => readLastAssistantMessage(cwd, sessionId),
    limits: cfg.limits,
  });

  const indexHtml = await readFile(path.join(__dirname, "public", "index.html"), "utf8");

  /** Read a request's JSON body (small payloads only). */
  const readJson = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });
  const sendJson = (res: http.ServerResponse, code: number, obj: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(indexHtml);
        return;
      }
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Stop-hook notifier for an attached, hand-started claude session.
      if (req.method === "POST" && req.url === "/hook") {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          return sendJson(res, 400, { action: "stop", prompt: null, reason: "bad json" });
        }
        const decision = await attach.handle(body as Parameters<typeof attach.handle>[0]);
        return sendJson(res, 200, decision);
      }

      // Observability read APIs (history + metrics). GET, JSON, read-only.
      if (req.method === "GET" && req.url?.startsWith("/api/")) {
        const u = new URL(req.url, "http://localhost");
        const session = u.searchParams.get("session") ?? undefined;
        if (u.pathname === "/api/runs") return sendJson(res, 200, store.getRuns(session, 50));
        if (u.pathname === "/api/metrics") return sendJson(res, 200, store.metrics(session));
        if (u.pathname === "/api/run") {
          const runId = Number(u.searchParams.get("id"));
          if (!runId) return sendJson(res, 400, { error: "id required" });
          return sendJson(res, 200, {
            run: store.getRun(runId),
            turns: store.getTurns(runId),
            decisions: store.getDecisions(runId),
            events: store.getEvents(runId),
          });
        }
        return sendJson(res, 404, { error: "unknown api" });
      }

      // Register / unregister an attached session (goal + doneCriteria for an id).
      if (req.method === "POST" && (req.url === "/attach" || req.url === "/detach")) {
        let body: { session_id?: string; goal?: string; doneCriteria?: string };
        try {
          body = (await readJson(req)) as typeof body;
        } catch {
          return sendJson(res, 400, { ok: false, error: "bad json" });
        }
        if (!body.session_id) return sendJson(res, 400, { ok: false, error: "session_id required" });
        if (req.url === "/detach") {
          attach.unregister(body.session_id);
          return sendJson(res, 200, { ok: true, attached: false });
        }
        if (!body.goal || !body.doneCriteria) {
          return sendJson(res, 400, { ok: false, error: "goal and doneCriteria required" });
        }
        attach.register(body.session_id, { goal: body.goal, doneCriteria: body.doneCriteria });
        return sendJson(res, 200, { ok: true, attached: true });
      }

      res.writeHead(404);
      res.end("not found");
    })();
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    let focusId: string | undefined = cfg.sessions[0]?.id;

    const push = () => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "snapshot",
          provider: { model: cfg.provider.model, baseUrl: cfg.provider.baseUrl, ok: health.ok },
          budget: sup.budgetStatus(),
          sessions: sup.list(),
          focus: focusId ? { id: focusId, screen: sup.screen(focusId) } : undefined,
        }),
      );
    };

    const timer = setInterval(push, PUSH_MS);
    push();

    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const sendError = (message: string) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message }));
      };

      switch (msg.type) {
        case "start":
          if (msg.id) sup.start(msg.id);
          break;
        case "stop":
          if (msg.id) sup.stop(msg.id);
          break;
        case "startAll":
          sup.startAll();
          break;
        case "focus":
          focusId = msg.id;
          break;
        case "resolve":
          if (msg.id && msg.choice) sup.resolveAttention(msg.id, msg.choice);
          break;
        case "add":
          try {
            if (!msg.session) throw new Error("missing session payload.");
            const view = sup.addSession(msg.session);
            focusId = view.id;
          } catch (e) {
            sendError(e instanceof Error ? e.message : String(e));
          }
          break;
        case "update":
          try {
            if (!msg.id) throw new Error("missing session id.");
            if (!msg.patch) throw new Error("missing patch payload.");
            sup.updateSession(msg.id, msg.patch);
          } catch (e) {
            sendError(e instanceof Error ? e.message : String(e));
          }
          break;
        case "remove":
          try {
            if (!msg.id) throw new Error("missing session id.");
            sup.removeSession(msg.id);
            if (focusId === msg.id) focusId = sup.list()[0]?.id;
          } catch (e) {
            sendError(e instanceof Error ? e.message : String(e));
          }
          break;
      }
      push();
    });

    ws.on("close", () => clearInterval(timer));
  });

  const port = cfg.port ?? 4317;
  server.listen(port, () => {
    console.log(`\n🟢 dashboard → http://localhost:${port}\n`);
  });

  const shutdown = async () => {
    console.log("\nshutting down…");
    await sup.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
