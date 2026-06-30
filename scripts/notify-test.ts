/**
 * Deterministic test for outbound webhook notifications:
 *  - the Notifier selects subscribed webhooks (event filter + enabled flag),
 *  - formats payloads per type (json / slack / discord),
 *  - never throws on a failing transport,
 *  - and the Supervisor's webhook CRUD validates + round-trips through config.
 *
 * Points AGI_CONFIG at a scratch file so saveConfig can't clobber the real one.
 */
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

const tmp = mkdtempSync(path.join(os.tmpdir(), "agi-notify-"));
process.env.AGI_CONFIG = path.join(tmp, "config.json");

const { Notifier, subscribes, messageFor, bodyFor } = await import("../src/notify/notifier.js");
const { Supervisor } = await import("../src/server/supervisor.js");
import type { DeliveryResult, PostFn } from "../src/notify/notifier.js";
import type { AppConfig, WebhookConfig } from "../src/types.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const ctx = {
  id: "s1",
  label: "fix login bug",
  cwd: "C:\\proj",
  goal: "fix the login bug",
  status: "done",
  turns: 12,
  elapsedMin: 8,
};

// ---- subscription matching --------------------------------------------------
const all: WebhookConfig = { id: "a", name: "all", url: "http://x", createdAt: 0, updatedAt: 0 };
const onlyDone: WebhookConfig = { ...all, id: "b", events: ["done"] };
const onlyError: WebhookConfig = { ...all, id: "c", events: ["error"] };
const disabled: WebhookConfig = { ...all, id: "d", enabled: false };

check("no events => subscribes to all", subscribes(all, "done") && subscribes(all, "error"));
check("events filter matches", subscribes(onlyDone, "done") && !subscribes(onlyDone, "error"));
check("non-matching event is skipped", !subscribes(onlyError, "done"));
check("disabled never subscribes", !subscribes(disabled, "done"));

// ---- message + body formatting ----------------------------------------------
const msg = messageFor("done", ctx);
check("message names the label", msg.includes("fix login bug"));
check("message states turns", msg.includes("12 turn"));

const payload = {
  event: "done" as const,
  message: msg,
  session: { id: "s1", label: ctx.label, cwd: ctx.cwd, goal: ctx.goal, status: "done", turns: 12, elapsedMin: 8 },
  timestamp: 0,
};
check("slack body uses { text }", JSON.parse(bodyFor("slack", payload)).text === msg);
check("discord body uses { content }", JSON.parse(bodyFor("discord", payload)).content === msg);
check("json body carries the event", JSON.parse(bodyFor("json", payload)).event === "done");
check("json body carries the session", JSON.parse(bodyFor("json", payload)).session.turns === 12);

// ---- Notifier.fire selects + dispatches -------------------------------------
const calls: { url: string; body: string }[] = [];
const recordingPost: PostFn = async (url, body) => {
  calls.push({ url, body });
  return { ok: true, status: 200 };
};
let hooks: WebhookConfig[] = [
  { id: "h1", name: "slack", url: "http://hook/slack", format: "slack", events: ["done"], createdAt: 0, updatedAt: 0 },
  { id: "h2", name: "json-all", url: "http://hook/all", createdAt: 0, updatedAt: 0 },
  { id: "h3", name: "errors", url: "http://hook/err", events: ["error"], createdAt: 0, updatedAt: 0 },
  { id: "h4", name: "off", url: "http://hook/off", enabled: false, createdAt: 0, updatedAt: 0 },
];
const notifier = new Notifier(() => hooks, recordingPost);

check("active reflects enabled hooks", notifier.active === true);
const fired = await notifier.fire("done", ctx);
check("fire('done') hits slack + json-all only (2)", fired === 2);
check("slack hook got { text }", calls.some((c) => c.url === "http://hook/slack" && !!JSON.parse(c.body).text));
check("error-only hook did NOT fire", !calls.some((c) => c.url === "http://hook/err"));
check("disabled hook did NOT fire", !calls.some((c) => c.url === "http://hook/off"));

// ---- failing transport never throws -----------------------------------------
const throwingPost: PostFn = async () => {
  throw new Error("connection refused");
};
let threw = false;
let logged = "";
const robust = new Notifier(() => hooks, throwingPost, (m) => (logged = m));
try {
  await robust.fire("done", ctx);
} catch {
  threw = true;
}
check("fire never throws on a dead endpoint", !threw);
check("a failed delivery is logged", logged.includes("failed"));

// ---- Supervisor webhook CRUD + config round-trip ----------------------------
const cfg: AppConfig = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b", apiKey: "local", temperature: 0.3 },
  limits: { maxTurns: 5, maxWallClockMin: 10, pingPongThreshold: 3, stuckTurns: 4 },
  sessions: [{ id: "s1", cwd: tmp, goal: "g", doneCriteria: "d", permissionMode: "acceptEdits" }],
};
const sup = new Supervisor(cfg, undefined, undefined, () => new Promise<void>(() => {}));

const w = sup.saveWebhook({ name: "Slack", url: "https://hooks.slack.com/x", format: "slack", events: ["done", "error"] });
check("saveWebhook returns an id + timestamps", !!w.id && w.createdAt > 0 && w.updatedAt > 0);
check("listWebhooks has it", sup.listWebhooks().some((x) => x.id === w.id));
check("webhook fields persisted", w.format === "slack" && w.events?.length === 2 && w.enabled === true);

let badName = false;
try {
  sup.saveWebhook({ name: "", url: "https://x" });
} catch {
  badName = true;
}
check("blank name is rejected", badName);

let badUrl = false;
try {
  sup.saveWebhook({ name: "bad", url: "ftp://nope" });
} catch {
  badUrl = true;
}
check("non-http url is rejected", badUrl);

const updated = sup.saveWebhook({ id: w.id, name: "Slack #builds", url: w.url, enabled: false });
check("update reuses the id", updated.id === w.id);
check("update does not duplicate", sup.listWebhooks().filter((x) => x.id === w.id).length === 1);
check("update changes a field", sup.listWebhooks().find((x) => x.id === w.id)?.enabled === false);

sup.deleteWebhook(w.id);
check("deleteWebhook removes it", !sup.listWebhooks().some((x) => x.id === w.id));

// config round-trip via the real load/save
const { loadConfig, saveConfig } = await import("../src/config.js");
cfg.webhooks = [{ id: "rt", name: "RT", url: "https://x.test", format: "discord", createdAt: 1, updatedAt: 2 }];
await saveConfig(cfg);
const reloaded = await loadConfig();
check("webhooks survive a save→load round-trip", reloaded.webhooks?.[0]?.id === "rt");
check("round-tripped webhook keeps its format", reloaded.webhooks?.[0]?.format === "discord");

console.log(`\n[notify] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
