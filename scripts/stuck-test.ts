/**
 * Deterministic test of stuck detection: the StuckDetector streak logic and that
 * fingerprintDir actually changes when files change (and ignores noise dirs).
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { StuckDetector, fingerprintDir } from "../src/policy/stuck.js";

let pass = true;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "ok  " : "FAIL"} ${n}`); if (!c) pass = false; };

// --- detector streak logic ---
const d = new StuckDetector();
d.record("A"); // first, no comparison
d.record("A");
d.record("A");
check("not stuck before threshold", d.isStuck(3) === false);
d.record("A"); // streak now 3
check("stuck at threshold (3)", d.isStuck(3) === true);
check("isStuck(0) disabled", d.isStuck(0) === false);
d.record("B"); // change resets
check("change resets streak", d.isStuck(3) === false && d.streak === 0);
d.record("B"); d.record("B"); d.record("B");
d.reset();
check("reset clears streak", d.streak === 0);

// --- fingerprintDir reflects real file changes ---
const DIR = "C:\\Users\\panda\\Desktop\\AGI\\.scratch\\stuck-fp";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const f1 = fingerprintDir(DIR);
writeFileSync(`${DIR}\\a.txt`, "hello");
const f2 = fingerprintDir(DIR);
check("fingerprint changes when a file is added", f1 !== f2);
const f3 = fingerprintDir(DIR);
check("fingerprint stable when nothing changes", f2 === f3);
writeFileSync(`${DIR}\\a.txt`, "hello world (edited)");
check("fingerprint changes when a file is edited", fingerprintDir(DIR) !== f2);

// noise dir ignored
const f4 = fingerprintDir(DIR);
mkdirSync(`${DIR}\\node_modules`, { recursive: true });
writeFileSync(`${DIR}\\node_modules\\junk.js`, "x".repeat(50));
check("node_modules changes are ignored", fingerprintDir(DIR) === f4);

rmSync(DIR, { recursive: true, force: true });
console.log(`\n[stuck] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
