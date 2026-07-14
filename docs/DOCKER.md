# Running AGI Orchestrator in Docker

The provided image bundles the **orchestrator server + dashboard + the `claude` CLI**. It
deliberately does **not** bundle two things, because doing so would break the project's core
guarantee:

| Not in the image | Why | How it's provided |
| --- | --- | --- |
| Your Claude **subscription login** | Baking credentials into an image is unsafe, and the tool must draw from *your* subscription | Mount the host's `~/.claude` |
| The **local brain model** (Qwen) | The brain must talk to a **loopback** endpoint (subscription-safety check), and models are large | Run LM Studio / Ollama on the host and use host networking |

> **Read [SECURITY.md](../SECURITY.md) first.** A container that can start sessions has, in
> effect, shell access to every mounted project directory. Don't expose the port publicly
> without a token and a TLS tunnel.

---

## The host-networking constraint (important)

The brain's provider `baseUrl` **must** resolve to `localhost` / `127.0.0.1` / `::1` — the
orchestrator refuses a non-loopback URL to stay subscription-safe (`src/config.ts`). Inside a
normal bridge-networked container, `localhost` is the *container*, not your host, so it can't
reach the model.

The clean fix is **host networking** (`network_mode: host` in the compose file): the container
shares the host's network stack, so `http://localhost:11434/v1` reaches the host's Ollama **and**
passes the loopback check.

- **Linux hosts:** host networking works natively. This is the supported, recommended setup.
- **Docker Desktop (macOS / Windows):** host networking is
  [more limited](https://docs.docker.com/network/drivers/host/). Two options:
  1. Enable "Host networking" in Docker Desktop settings (recent versions support it), or
  2. Use bridge networking + `host.docker.internal`, and run the container with an env flag that
     the loopback check treats as local. **The current code does not provide such an escape
     hatch** — `host.docker.internal` would be rejected. So on Docker Desktop, prefer option 1,
     or run the orchestrator natively (`npm start`) and containerize only your other services.

If you need `host.docker.internal` support, that's a reasonable feature request — see
[CONTRIBUTING.md](../CONTRIBUTING.md); it would relax the loopback check to also accept the
Docker gateway host *only* when an explicit opt-in env var is set.

---

## Quick start (Linux host, recommended)

```bash
# 1. One-time host setup
claude                       # then /login  — authenticates your subscription
ollama serve &               # or start LM Studio; must expose an OpenAI-compatible API
ollama pull qwen3:8b         # a fast instruct model for the brain

# 2. Configure
cp config.example.json config.json
#   - set provider.baseUrl to http://localhost:11434/v1 (Ollama) or :1234/v1 (LM Studio)
#   - set provider.model to what your server reports under /v1/models
#   - set each session's cwd to a path you will bind-mount (see below)

# 3. Build & run
docker compose up --build
```

Open **http://localhost:4317**.

### Mounting your project directories

Each session's `cwd` in `config.json` is a path *inside the container*. For claude to actually
edit your code, that path must be bind-mounted. The simplest convention is to mount your projects
at the **same absolute path** the host uses, so config paths "just work":

```yaml
# docker-compose.yml → services.agi.volumes:
- /home/you/projects:/home/you/projects
```

Then a session with `"cwd": "/home/you/projects/my-app"` resolves correctly in both worlds.

---

## Using the plain Dockerfile (no compose)

```bash
docker build -t agi-orchestrator:latest .

docker run --rm -it \
  --network host \
  -e AGI_PORT=4317 \
  -v "$PWD/config.json:/app/config.json:ro" \
  -v "$HOME/.claude:/home/node/.claude" \
  -v agi-data:/data \
  -v "/home/you/projects:/home/you/projects" \
  agi-orchestrator:latest
```

---

## Optional: bundle Ollama as a second container

If you'd rather not run Ollama on the host, add an Ollama service. Because the brain check
requires loopback, the **orchestrator and Ollama must share a network namespace** — the easiest
way is to keep the orchestrator on `network_mode: host` and also run Ollama with host
networking, so `localhost:11434` reaches it. Create `docker-compose.ollama.yml`:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    network_mode: host          # exposes 11434 on the host loopback
    volumes:
      - ollama-models:/root/.ollama
    restart: unless-stopped
    # For GPU acceleration (NVIDIA), add:
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - capabilities: [gpu]

volumes:
  ollama-models:
```

Run both, then pull a model into the container:

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama.yml up --build -d
docker compose exec ollama ollama pull qwen3:8b
```

Keep `provider.baseUrl` as `http://localhost:11434/v1`. **Note:** CPU-only inference is slow;
the brain runs once per turn, so pass a GPU through for a usable pace (see the `deploy` block
above, and Docker's GPU docs).

---

## Configuration reference

| Env var | Purpose | Default |
| --- | --- | --- |
| `AGI_PORT` | Dashboard port | `4317` |
| `AGI_CONFIG` | Path to config JSON inside the container | `/app/config.json` |
| `AGI_DB` | SQLite store path (mount it as a volume) | `/data/agi.db` |
| `AGI_DISPATCH_TOKEN` | Remote-access token (see [SECURITY.md](../SECURITY.md)) | unset (remote refused) |

All other settings live in `config.json` — see the
[configuration reference](CONFIGURATION.md) and
[`schemas/config.schema.json`](../schemas/config.schema.json).

---

## Troubleshooting

- **`config.provider.baseUrl must be a local endpoint`** — you're not on host networking, or
  you pointed the brain at a remote/bridge host. Use `network_mode: host` and a `localhost` URL.
- **`Refusing to start: ANTHROPIC_API_KEY …`** — an API-billing env var is set. Unset it; the
  container must use the mounted subscription login, not an API key. (This guard is intentional.)
- **claude says it's not logged in** — you didn't mount `~/.claude`, or you never ran `/login`
  on the host. Authenticate on the host first, then mount it.
- **The agent can't find/edit files** — the session's `cwd` isn't bind-mounted, or the in-
  container path differs from `config.json`. Mount projects at matching absolute paths.
- **Brain calls are very slow** — CPU inference. Use a smaller/faster model or pass a GPU
  through to the model server.
- **Live screen / gates don't render in headless engine** — expected: `claude-headless` has no
  TUI. Use the default `claude` engine for the interactive dashboard experience.
