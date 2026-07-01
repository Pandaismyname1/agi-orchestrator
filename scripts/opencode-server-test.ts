/**
 * Deterministic test for OpenCodeServerManager — no real process, no real server.
 * Injected spawn + fetch simulate: (a) a cold port that needs a spawn then becomes
 * healthy, (b) a port that's already healthy (attach, no spawn), (c) reuse across
 * ensure() calls, (d) dispose killing a spawned child, (e) a server that never
 * comes up (timeout → throws + cleans up).
 */
import { OpenCodeServerManager, type ChildLike } from "../src/session/opencodeServer.js";

let pass = true;
const check = (n: string, c: boolean) => {
  console.log(`  ${c ? "ok  " : "FAIL"} ${n}`);
  if (!c) pass = false;
};

function fakeChild(): ChildLike & { killed: boolean } {
  return {
    killed: false,
    kill() {
      this.killed = true;
      return true;
    },
    once() {},
    unref() {},
  };
}

const okResp = () => new Response("[]", { status: 200 });
const badResp = () => new Response("no", { status: 503 });

// --- (a) cold port: unhealthy until spawned, then healthy on the 2nd poll ------
{
  let spawns = 0;
  let health = 0;
  const child = fakeChild();
  const mgr = new OpenCodeServerManager({
    port: 5000,
    pollMs: 1,
    readyTimeoutMs: 500,
    spawnImpl: () => {
      spawns++;
      return child;
    },
    fetchImpl: (async () => {
      health++;
      // first check (pre-spawn) fails; after spawn, the 2nd health poll succeeds
      return health >= 2 ? okResp() : badResp();
    }) as typeof fetch,
  });

  const url = await mgr.ensure();
  check("cold: ensure returns the port URL", url === "http://127.0.0.1:5000");
  check("cold: spawned exactly once", spawns === 1);
  check("cold: reports spawned", mgr.spawned === true);

  const url2 = await mgr.ensure();
  check("reuse: second ensure returns cached URL without spawning again", url2 === url && spawns === 1);

  mgr.dispose();
  check("dispose kills the spawned child", child.killed === true);
  check("dispose clears spawned flag", mgr.spawned === false);
}

// --- (b) already-healthy port: attach, never spawn ----------------------------
{
  let spawns = 0;
  const mgr = new OpenCodeServerManager({
    port: 5001,
    pollMs: 1,
    spawnImpl: () => {
      spawns++;
      return fakeChild();
    },
    fetchImpl: (async () => okResp()) as typeof fetch,
  });
  const url = await mgr.ensure();
  check("attach: ensure returns URL", url === "http://127.0.0.1:5001");
  check("attach: did NOT spawn (reused running server)", spawns === 0 && mgr.spawned === false);
}

// --- (c) never comes up: times out, throws, no lingering child ----------------
{
  const child = fakeChild();
  const mgr = new OpenCodeServerManager({
    port: 5002,
    pollMs: 1,
    readyTimeoutMs: 20,
    spawnImpl: () => child,
    fetchImpl: (async () => badResp()) as typeof fetch, // never healthy
  });
  let threw = false;
  try {
    await mgr.ensure();
  } catch (e) {
    threw = /did not become healthy/.test((e as Error).message);
  }
  check("timeout: ensure throws when server never answers", threw);
  check("timeout: dud child was killed", child.killed === true);
}

console.log(`\n[opencode-server] => ${pass ? "PASS ✅" : "FAIL ⚠️"}`);
process.exit(pass ? 0 : 1);
