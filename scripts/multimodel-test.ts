/**
 * Deterministic tests for the multi-model brain (smarter brain context, slice 3):
 * the loopback cost-guard, config rejection of a non-local escalationProvider, and
 * refineEscalation's "pure upgrade, never worse" contract (fallback to the fast
 * model's escalation on any heavy-model failure / garbage / empty options).
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { loadConfig, isLoopbackEndpoint } from "../src/config.js";
import { refineEscalation, gateLowConfidence } from "../src/brain/decide.js";
import type { LocalLLM, ChatMessage } from "../src/brain/provider.js";
import type { Decision, SessionConfig } from "../src/types.js";

const ROOT = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\multimodel-test";
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

// ── 1. loopback guard ──────────────────────────────────────────────────────
check("localhost is loopback", isLoopbackEndpoint("http://localhost:11434/v1"));
check("127.0.0.1 is loopback", isLoopbackEndpoint("http://127.0.0.1:1234/v1"));
check("::1 is loopback", isLoopbackEndpoint("http://[::1]:1234/v1"));
check("remote host is NOT loopback", !isLoopbackEndpoint("https://api.openai.com/v1"));
check("LAN IP is NOT loopback", !isLoopbackEndpoint("http://192.168.1.50:11434/v1"));
check("garbage is NOT loopback", !isLoopbackEndpoint("not-a-url"));

// ── 2. config rejects a non-local escalationProvider ───────────────────────
const base = {
  provider: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5:9b" },
  sessions: [{ cwd: ROOT, goal: "g", doneCriteria: "d" }],
};
const writeCfg = (obj: unknown, name: string) => {
  const p = `${ROOT}\\${name}`;
  writeFileSync(p, JSON.stringify(obj));
  return p;
};
let rejected = false;
try {
  await loadConfig(writeCfg({ ...base, escalationProvider: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" } }, "remote.json"));
} catch {
  rejected = true;
}
check("rejects a remote escalationProvider (cost guard)", rejected);

const okCfg = await loadConfig(
  writeCfg({ ...base, escalationProvider: { baseUrl: "http://localhost:1234/v1", model: "qwen3.5:32b" } }, "local.json"),
);
check("accepts a local escalationProvider", okCfg.escalationProvider?.model === "qwen3.5:32b");
check("escalationProvider gets default apiKey/temperature", okCfg.escalationProvider?.apiKey === "local");
const noEsc = await loadConfig(writeCfg(base, "none.json"));
check("escalationProvider omitted => undefined (no-regression)", noEsc.escalationProvider === undefined);

// ── 3. refineEscalation: pure upgrade, never worse ─────────────────────────
const session = { id: "s", cwd: ROOT, goal: "g", doneCriteria: "d" } as SessionConfig;
const draft: Decision = {
  action: "escalate",
  reason: "needs a human",
  question: "fast question?",
  options: [{ label: "fast A", rationale: "r", prompt: "do fast A" }],
};

// non-escalate draft is returned untouched
const cont: Decision = { action: "continue", prompt: "go", reason: "r" };
const goodHeavy = { chat: async () => JSON.stringify({ question: "sharp?", options: [{ label: "Heavy A", rationale: "r", prompt: "do heavy A" }, { label: "Heavy B", rationale: "r2", prompt: "do heavy B" }] }) } as unknown as LocalLLM;
check("non-escalate decision passes through unchanged", (await refineEscalation(goodHeavy, session, "x", 2, undefined, undefined, cont)) === cont);

const refined = await refineEscalation(goodHeavy, session, "agent said done", 2, undefined, "branch main\nCLEAN", draft);
check("heavy refines the question", refined.action === "escalate" && refined.question === "sharp?");
check("heavy replaces the options", refined.action === "escalate" && refined.options?.length === 2 && refined.options?.[0]?.label === "Heavy A");
check("refined keeps the fast model's reason", refined.action === "escalate" && refined.reason === "needs a human");

// heavy model throws → fall back to the fast escalation
const throwingHeavy = { chat: async () => { throw new Error("model unloaded"); } } as unknown as LocalLLM;
const fb1 = await refineEscalation(throwingHeavy, session, "x", 2, undefined, undefined, draft);
check("heavy error → falls back to the fast escalation", fb1 === draft);

// heavy returns garbage / no usable options → fall back
const garbageHeavy = { chat: async () => "sorry I cannot help with that" } as unknown as LocalLLM;
const fb2 = await refineEscalation(garbageHeavy, session, "x", 2, undefined, undefined, draft);
check("heavy garbage → falls back to the fast escalation", fb2 === draft);

const emptyOptHeavy = { chat: async () => JSON.stringify({ question: "q?", options: [] }) } as unknown as LocalLLM;
const fb3 = await refineEscalation(emptyOptHeavy, session, "x", 2, undefined, undefined, draft);
check("heavy with no options → falls back to the fast escalation", fb3 === draft);

// the heavy model actually receives REPO STATE in its prompt
let heavySaw = "";
const spyHeavy = { chat: async (m: ChatMessage[]) => { heavySaw = m[1]?.content ?? ""; return JSON.stringify({ question: "q?", options: [{ label: "A", rationale: "r", prompt: "p" }] }); } } as unknown as LocalLLM;
await refineEscalation(spyHeavy, session, "x", 2, undefined, "branch main\n3 uncommitted file(s):", draft);
check("heavy prompt includes REPO STATE", /REPO STATE/.test(heavySaw) && /3 uncommitted file/.test(heavySaw));

// ── 4. confidence gate: low-confidence continue auto-escalates ─────────────
const lowConf: Decision = { action: "continue", prompt: "do X", reason: "next step", confidence: 0.3 };
const hiConf: Decision = { action: "continue", prompt: "do X", reason: "next step", confidence: 0.9 };
const noConf: Decision = { action: "continue", prompt: "do X", reason: "next step" };

check("threshold 0 disables the gate (no-regression)", gateLowConfidence(lowConf, 0) === lowConf);
check("threshold undefined disables the gate", gateLowConfidence(lowConf, undefined) === lowConf);
check("high-confidence continue passes through", gateLowConfidence(hiConf, 0.7) === hiConf);
check("no reported confidence is never gated", gateLowConfidence(noConf, 0.7) === noConf);

const gated = gateLowConfidence(lowConf, 0.7);
check("low-confidence continue auto-escalates", gated.action === "escalate");
check("auto-escalation keeps the proposed step as an option", gated.options?.some((o) => o.prompt === "do X") ?? false);
check("auto-escalation offers a redirect option", (gated.options?.length ?? 0) >= 2);
check("auto-escalation carries the confidence through", gated.confidence === 0.3);

const stopLow: Decision = { action: "stop", reason: "done", confidence: 0.2 };
check("low-confidence STOP is NOT gated (human already involved)", gateLowConfidence(stopLow, 0.7) === stopLow);

// config validation of the threshold range
let badRange = false;
try {
  await loadConfig(writeCfg({ ...base, brain: { confidenceThreshold: 1.5 } }, "badconf.json"));
} catch {
  badRange = true;
}
check("config rejects confidenceThreshold out of [0,1]", badRange);
const okBrain = await loadConfig(writeCfg({ ...base, brain: { confidenceThreshold: 0.6 } }, "okconf.json"));
check("config accepts a valid confidenceThreshold", okBrain.brain?.confidenceThreshold === 0.6);

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n[multimodel] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
