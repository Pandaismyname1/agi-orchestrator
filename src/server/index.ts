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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { preflight, BillingSafetyError } from "../util/env.js";
import { loadConfig, saveConfig } from "../config.js";
import { Supervisor } from "./supervisor.js";
import { openStore } from "../db/store.js";
import { SessionDiscovery } from "../discovery.js";
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
  startMode?: SessionConfig["startMode"];
  resumeId?: SessionConfig["resumeId"];
}

type SessionPatch = Partial<{
  cwd: string;
  goal: string;
  doneCriteria: string;
  permissionMode: SessionConfig["permissionMode"];
  autonomy: SessionConfig["autonomy"];
  startMode: SessionConfig["startMode"];
}>;

/** Runtime-editable global settings patch (see the "updateSettings" handler). */
type SettingsPatch = Partial<{
  providerModel: string;
  maxConcurrent: number;
  budgetMaxTurns: number | null;
  budgetMaxMinutes: number | null;
  defaultPermissionMode: SessionConfig["permissionMode"];
  defaultAutonomy: SessionConfig["autonomy"];
}>;

/** Continue a finished session in the same conversation (edited goal + next step). */
type ContinuePatch = Partial<{
  goal: string;
  doneCriteria: string;
  instruction: string;
  startMode: "manual" | "autopilot";
}>;

interface ClientMsg {
  type:
    | "start" | "stop" | "startAll" | "focus" | "add" | "update" | "remove" | "resolve"
    | "setMode" | "sendMessage" | "updateSettings" | "continue"
    | "learnSynthesize" | "learnApprove" | "learnReject" | "learnRevert";
  id?: string;
  session?: SessionInput;
  patch?: SessionPatch;
  /** For "updateSettings": the global-settings fields to change. */
  settings?: SettingsPatch;
  /** For "continue": the edited goal / instruction / mode to resume with. */
  continue?: ContinuePatch;
  /** For "learn*": the profile scope ("global" or "cwd:<path>") and version. */
  scope?: string;
  version?: number;
  /** For "resolve": how the user answered an open human-decision. */
  choice?: { optionIndex?: number; customPrompt?: string; stop?: boolean };
  /** For "setMode": the target mode. For "sendMessage": the message text. */
  mode?: "manual" | "autopilot";
  text?: string;
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

  const discovery = new SessionDiscovery();

  // Frontend: serve the built Svelte SPA from web/dist when present (run
  // `npm run web:build`), else fall back to the legacy single-file dashboard.
  // __dirname = src/server → repo root is two levels up.
  const repoRoot = path.resolve(__dirname, "..", "..");
  const webDist = path.join(repoRoot, "web", "dist");
  const hasSpa = existsSync(path.join(webDist, "index.html"));
  const staticRoot = hasSpa ? webDist : path.join(__dirname, "public");
  console.log(hasSpa ? `serving Svelte SPA → ${webDist}` : `serving legacy dashboard (web/dist not built)`);

  const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
  };

  /** Serve a file from the static root, guarding against path traversal. */
  const serveStatic = async (res: http.ServerResponse, urlPath: string): Promise<boolean> => {
    const rel = urlPath.replace(/^\/+/, "");
    const abs = path.join(staticRoot, rel);
    if (!abs.startsWith(staticRoot) || !existsSync(abs)) return false;
    const body = await readFile(abs);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(abs)] ?? "application/octet-stream" });
    res.end(body);
    return true;
  };

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
        const html = await readFile(path.join(staticRoot, "index.html"), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Built SPA assets (hashed JS/CSS/fonts under /assets/, etc.).
      if (req.method === "GET" && req.url && !req.url.startsWith("/api/")) {
        const urlPath = req.url.split("?")[0] ?? "/";
        if (urlPath !== "/" && (await serveStatic(res, urlPath))) return;
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
        if (u.pathname === "/api/discover") return sendJson(res, 200, await discovery.list(60));
        if (u.pathname === "/api/learning") return sendJson(res, 200, sup.learningSummary());
        if (u.pathname === "/api/learning/draft") {
          return sendJson(res, 200, sup.learningDraft(u.searchParams.get("scope") ?? undefined));
        }
        if (u.pathname === "/api/learning/versions") {
          return sendJson(res, 200, sup.learningVersions(u.searchParams.get("scope") ?? undefined));
        }
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
          settings: {
            providerModel: cfg.provider.model,
            providerBaseUrl: cfg.provider.baseUrl,
            maxConcurrent: cfg.maxConcurrent ?? 2,
            budget: {
              maxTurns: cfg.budget?.maxTurnsPerDay ?? null,
              maxMinutes: cfg.budget?.maxMinutesPerDay ?? null,
            },
            defaults: {
              permissionMode: cfg.defaults?.permissionMode ?? "acceptEdits",
              autonomy: cfg.defaults?.autonomy ?? "balanced",
            },
          },
          learning: sup.learningSummary(),
          sessions: sup.list(),
          focus: focusId ? { id: focusId, screen: sup.screen(focusId) } : undefined,
        }),
      );
    };

    const timer = setInterval(push, PUSH_MS);
    push();

    ws.on("message", async (raw) => {
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
        case "setMode":
          if (msg.id && msg.mode) sup.setMode(msg.id, msg.mode);
          break;
        case "sendMessage":
          if (msg.id && typeof msg.text === "string") sup.sendMessage(msg.id, msg.text);
          break;
        case "continue":
          try {
            if (!msg.id) throw new Error("missing session id.");
            sup.continueSession(msg.id, msg.continue ?? {});
          } catch (e) {
            sendError(e instanceof Error ? e.message : String(e));
          }
          break;
        case "learnSynthesize":
          // Mining + an LLM call — run it, then push the refreshed snapshot.
          sup
            .learnSynthesize(msg.scope)
            .then(() => push())
            .catch((e) => sendError(e instanceof Error ? e.message : String(e)));
          break;
        case "learnApprove":
          try {
            sup.learnApprove(msg.scope);
          } catch (e) {
            sendError(e instanceof Error ? e.message : String(e));
          }
          break;
        case "learnReject":
          sup.learnReject(msg.scope);
          break;
        case "learnRevert":
          try {
            if (typeof msg.scope !== "string" || typeof msg.version !== "number") {
              throw new Error("scope and version are required.");
            }
            sup.learnRevert(msg.scope, msg.version);
          } catch (e) {
            sendError(e instanceof Error ? e.message : String(e));
          }
          break;
        case "updateSettings":
          try {
            const p = msg.settings ?? {};
            let applyConcurrency = false;
            let applyBudget = false;

            // Provider model: non-empty string. Persisting is enough (read when
            // the brain/health is constructed); we don't re-run health here.
            if (typeof p.providerModel === "string" && p.providerModel.trim()) {
              cfg.provider.model = p.providerModel.trim();
            }

            // Concurrency cap: finite number >= 1.
            if (typeof p.maxConcurrent === "number" && Number.isFinite(p.maxConcurrent) && p.maxConcurrent >= 1) {
              cfg.maxConcurrent = Math.floor(p.maxConcurrent);
              applyConcurrency = true;
            }

            // Budget caps: null clears the cap; a finite number >= 0 sets it.
            if (p.budgetMaxTurns !== undefined) {
              if (p.budgetMaxTurns === null) {
                cfg.budget = { ...cfg.budget, maxTurnsPerDay: undefined };
                applyBudget = true;
              } else if (Number.isFinite(p.budgetMaxTurns) && p.budgetMaxTurns >= 0) {
                cfg.budget = { ...cfg.budget, maxTurnsPerDay: Math.floor(p.budgetMaxTurns) };
                applyBudget = true;
              }
            }
            if (p.budgetMaxMinutes !== undefined) {
              if (p.budgetMaxMinutes === null) {
                cfg.budget = { ...cfg.budget, maxMinutesPerDay: undefined };
                applyBudget = true;
              } else if (Number.isFinite(p.budgetMaxMinutes) && p.budgetMaxMinutes >= 0) {
                cfg.budget = { ...cfg.budget, maxMinutesPerDay: Math.floor(p.budgetMaxMinutes) };
                applyBudget = true;
              }
            }

            // Defaults for newly created sessions. Persisted; addSession reads
            // its own defaults today, so these take effect when that wiring uses
            // cfg.defaults. (TODO: have addSession fall back to cfg.defaults.)
            if (p.defaultPermissionMode !== undefined) {
              cfg.defaults = { ...cfg.defaults, permissionMode: p.defaultPermissionMode };
            }
            if (p.defaultAutonomy !== undefined) {
              cfg.defaults = { ...cfg.defaults, autonomy: p.defaultAutonomy };
            }

            // Apply at runtime what's safe.
            if (applyConcurrency) sup.setMaxConcurrent(cfg.maxConcurrent ?? Infinity);
            if (applyBudget) sup.setBudgetLimits();

            await saveConfig(cfg);
          } catch (e) {
            sendError(e instanceof Error ? e.message : String(e));
          }
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
    const url = `http://localhost:${port}`;
    console.log(`\n🟢 dashboard → ${url}\n`);
    // Opt-in browser auto-open (set by launch.cmd / `npm run launch`). Off for
    // the daemon and for `tsx watch` restarts so it doesn't spam tabs.
    if (process.env.AGI_OPEN === "1") {
      const open =
        process.platform === "win32"
          ? `start "" "${url}"`
          : process.platform === "darwin"
            ? `open "${url}"`
            : `xdg-open "${url}"`;
      void import("node:child_process").then(({ exec }) => exec(open, () => {}));
    }
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
