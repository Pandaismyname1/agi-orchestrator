/**
 * Deterministic test for the structured logger: level gating, JSON + pretty
 * formatting, the pure rotation plan, and real size-based rotation in a temp dir.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Logger,
  createLogger,
  levelEnabled,
  formatLine,
  prettyLine,
  rotationPlan,
} from "../src/util/logger.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

const ISO = "2026-06-30T12:00:00.000Z";

// ---- level gating -----------------------------------------------------------
check("info logger emits warn/error", levelEnabled("info", "warn") && levelEnabled("info", "error"));
check("info logger drops debug", !levelEnabled("info", "debug"));
check("debug logger emits everything", levelEnabled("debug", "debug") && levelEnabled("debug", "info"));
check("error logger drops info", !levelEnabled("error", "info"));

// ---- formatting -------------------------------------------------------------
const line = formatLine("info", "hello", { session: "s1", n: 3 }, ISO);
const rec = JSON.parse(line);
check("json line has ts/level/msg", rec.ts === ISO && rec.level === "info" && rec.msg === "hello");
check("json line carries fields", rec.session === "s1" && rec.n === 3);
check("fields can't clobber ts/level/msg", JSON.parse(formatLine("warn", "m", { level: "X", ts: "Y" }, ISO)).level === "warn");
check("pretty line is human-readable", prettyLine("error", "boom", { a: 1 }, ISO).includes("ERROR boom") && prettyLine("error", "boom", { a: 1 }, ISO).includes('{"a":1}'));

// ---- rotation plan (pure) ---------------------------------------------------
const plan = rotationPlan("/logs/app.log", 3);
check("plan drops the oldest (.3)", plan.unlink === "/logs/app.log.3");
check("plan renames highest-first (.2→.3, .1→.2, base→.1)",
  plan.renames.length === 3 &&
  plan.renames[0]!.from === "/logs/app.log.2" && plan.renames[0]!.to === "/logs/app.log.3" &&
  plan.renames[1]!.from === "/logs/app.log.1" && plan.renames[1]!.to === "/logs/app.log.2" &&
  plan.renames[2]!.from === "/logs/app.log" && plan.renames[2]!.to === "/logs/app.log.1");

// ---- real file logging + rotation in a temp dir -----------------------------
const dir = mkdtempSync(join(tmpdir(), "agi-log-"));
const file = join(dir, "app.log");

// console:false so the test output stays clean; tiny cap forces rotation.
const log = new Logger({ level: "info", file, maxBytes: 200, maxFiles: 3, console: false }, { now: () => new Date(ISO) });

check("debug is gated out (no file yet)", (log.debug("nope"), !existsSync(file)));
log.info("first message");
check("file is created on first emit", existsSync(file));
const firstContent = readFileSync(file, "utf8");
check("file holds a JSON line", firstContent.trim().startsWith("{") && firstContent.includes('"msg":"first message"'));

// Write enough to force at least one rotation (each line > ~60 bytes, cap 200).
for (let i = 0; i < 20; i++) log.info(`padding line number ${i} with some text to grow the file`);
check("rotation produced app.log.1", existsSync(`${file}.1`));
check("active log stays under a sane bound", statSync(file).size < 500);
check("never keeps more than maxFiles rotations", !existsSync(`${file}.4`));

// ---- child logger binds fields ----------------------------------------------
const child = log.child({ session: "abc" });
child.warn("heads up", { detail: "x" });
const lines = readFileSync(file, "utf8").trim().split("\n");
const last = JSON.parse(lines[lines.length - 1]!);
check("child binds session + merges call fields", last.session === "abc" && last.detail === "x" && last.level === "warn");

// ---- createLogger with no file is console-only (no throw, no file) ----------
const c = createLogger({ level: "debug" });
check("console-only logger doesn't throw / make a file", (c.info("ok"), true));

rmSync(dir, { recursive: true, force: true });
console.log(`\n[logger] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
