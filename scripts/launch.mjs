/**
 * One-command launch: build the dashboard UI, then start the dashboard server
 * with the browser auto-opening once it's listening. Used by `npm start` /
 * `npm run launch` and the desktop shortcut.
 */
import { spawn, spawnSync } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

console.log("▸ Building the dashboard UI…");
const build = spawnSync(npm, ["run", "web:build"], { stdio: "inherit" });
if (build.status !== 0) {
  console.error("\n✖ UI build failed — fix the error above and try again.");
  process.exit(build.status ?? 1);
}

console.log("\n▸ Starting the AGI dashboard…");
// AGI_OPEN=1 tells the server to open the browser once it's listening.
const server = spawn(npm, ["run", "dashboard"], {
  stdio: "inherit",
  env: { ...process.env, AGI_OPEN: "1" },
});
server.on("exit", (code) => process.exit(code ?? 0));
// Forward Ctrl+C cleanly to the server so it can shut sessions down.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => server.kill(sig));
}
