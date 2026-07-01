/**
 * OpenCode `serve` lifecycle — make an `engine:"opencode"` session work out of the
 * box without the operator hand-starting a server. A manager owns one headless
 * `opencode serve` per port and hands out its base URL:
 *
 *   - ATTACH: if something healthy is already listening on the port (e.g. the user
 *     ran `opencode serve` themselves, or another session started ours), reuse it.
 *   - SPAWN: otherwise launch `opencode serve --port <p> --hostname 127.0.0.1`,
 *     wait until it answers, and reuse it for every session on that port.
 *
 * Managers are shared per port (`getSharedServer`) so a fleet of OpenCode sessions
 * rides one server. `shutdownAllServers()` kills the ones we spawned (registered
 * on process exit). Spawn + fetch are injectable so this is unit-testable without
 * launching a real process.
 */
import { spawn as nodeSpawn } from "node:child_process";

/** The slice of a child process we use — swappable for a fake in tests. */
export interface ChildLike {
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", cb: (code: number | null) => void): void;
  unref?(): void;
}

export type SpawnLike = (command: string, args: string[]) => ChildLike;

export interface OpenCodeServerOptions {
  /** Port to manage. Default 4919. */
  port?: number;
  /** Hostname to bind/target. Default 127.0.0.1. */
  hostname?: string;
  /** Max ms to wait for a freshly spawned server to answer. Default 30000. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for health. Default 300. */
  pollMs?: number;
  /** Injected for tests; defaults to node child_process spawn. */
  spawnImpl?: SpawnLike;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const defaultSpawn: SpawnLike = (command, args) =>
  nodeSpawn(command, args, { stdio: "ignore", windowsHide: true }) as unknown as ChildLike;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenCodeServerManager {
  readonly port: number;
  private readonly hostname: string;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;
  private readonly spawnImpl: SpawnLike;
  private readonly fetchImpl: typeof fetch;

  private child?: ChildLike;
  /** Resolved base URL once ensured; also serves as the "already ensured" flag. */
  private url?: string;
  /** In-flight ensure() so concurrent sessions share one spawn. */
  private ensuring?: Promise<string>;

  constructor(opts: OpenCodeServerOptions = {}) {
    this.port = opts.port ?? 4919;
    this.hostname = opts.hostname ?? "127.0.0.1";
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 300;
    this.spawnImpl = opts.spawnImpl ?? defaultSpawn;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get baseUrl(): string {
    return `http://${this.hostname}:${this.port}`;
  }

  /** Is a server answering at `url`? Never throws. */
  private async healthy(url: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${url}/session`, { signal: AbortSignal.timeout(2500) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Ensure a healthy `opencode serve` and return its base URL (attach or spawn). */
  ensure(): Promise<string> {
    if (this.url) return Promise.resolve(this.url);
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.doEnsure().finally(() => {
      this.ensuring = undefined;
    });
    return this.ensuring;
  }

  private async doEnsure(): Promise<string> {
    const url = this.baseUrl;

    // Attach to an already-running server (user-started, or ours from a prior run).
    if (await this.healthy(url)) {
      this.url = url;
      return url;
    }

    // Spawn our own and wait for it to answer.
    this.child = this.spawnImpl("opencode", ["serve", "--port", String(this.port), "--hostname", this.hostname]);
    this.child.unref?.();
    this.child.once("exit", () => {
      if (!this.url) this.child = undefined; // died before ready
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      if (await this.healthy(url)) {
        this.url = url;
        return url;
      }
    }
    // Failed to come up — tear down the dud child.
    this.dispose();
    throw new Error(`opencode serve did not become healthy on ${url} within ${this.readyTimeoutMs}ms`);
  }

  /** True when this manager spawned (and still owns) a child process. */
  get spawned(): boolean {
    return !!this.child;
  }

  /** Kill the server if we spawned it. Safe to call repeatedly; no-op when attached. */
  dispose(): void {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
      this.child = undefined;
    }
    this.url = undefined;
  }
}

/** Shared managers keyed by port, so a fleet of OpenCode sessions rides one server. */
const shared = new Map<number, OpenCodeServerManager>();

/** Get (or create) the shared server manager for a port. */
export function getSharedServer(opts: OpenCodeServerOptions = {}): OpenCodeServerManager {
  const port = opts.port ?? 4919;
  let mgr = shared.get(port);
  if (!mgr) {
    mgr = new OpenCodeServerManager(opts);
    shared.set(port, mgr);
  }
  return mgr;
}

/** Kill every server we spawned (registered on process exit). */
export function shutdownAllServers(): void {
  for (const mgr of shared.values()) mgr.dispose();
  shared.clear();
}

// Best-effort cleanup so a spawned `opencode serve` doesn't outlive the daemon.
let cleanupHooked = false;
export function hookProcessCleanup(): void {
  if (cleanupHooked) return;
  cleanupHooked = true;
  process.once("exit", shutdownAllServers);
  process.once("SIGINT", () => {
    shutdownAllServers();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    shutdownAllServers();
    process.exit(143);
  });
}
