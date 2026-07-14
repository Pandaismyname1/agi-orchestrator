# syntax=docker/dockerfile:1
#
# AGI Orchestrator — container image (app + dashboard).
#
# This image bundles the orchestrator server, the built Svelte dashboard, and the
# `claude` CLI. It does NOT bundle your subscription login or the local brain model:
#   - Authenticate `claude` on the HOST, then mount ~/.claude into the container.
#   - Run your local LLM (LM Studio / Ollama) on the HOST and use host networking so
#     the brain's loopback-only check (localhost) is satisfied.
# See docs/DOCKER.md for the full run guide and the important caveats.

############################
# Stage 1 — build the UI
############################
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build            # → /app/web/dist

############################
# Stage 2 — server deps (compiles native node-pty)
############################
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# node-pty is a native addon: needs a C/C++ toolchain + python at install time.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

############################
# Stage 3 — runtime
############################
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/node \
    AGI_CONFIG=/app/config.json \
    AGI_DB=/data/agi.db

# git: used for per-turn diffs, snapshots and the auto-PR flow (and by claude).
# ca-certificates: TLS for outbound webhooks. Then the claude CLI, globally.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# App code + prebuilt UI + installed deps (node-pty already compiled in stage 2).
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=web   /app/web/dist     ./web/dist
COPY package.json tsconfig.json ./
COPY src/     ./src/
COPY scripts/ ./scripts/

# Persisted SQLite store lives on a mounted volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4317

# Serve the dashboard (no browser auto-open in a container). The server binds all
# interfaces; reach it at http://localhost:4317 on the host.
CMD ["npm", "run", "dashboard"]
