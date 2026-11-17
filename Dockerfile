# syntax=docker/dockerfile:1

# mcp-websocket-proxy — the Warren side of the tunnel.
#
# Two stages: the first installs every dependency (including the toolchain the
# build needs) and compiles TypeScript to `dist/`; the second is a small runtime
# that carries production dependencies plus `dist/` only. Nothing that can
# rebuild the app (typescript, vitest, tsx, the sources) ends up in the shipped
# image, which is also what makes `read_only: true` in
# `deploy/docker-compose.yml` workable: the container never writes to its own
# filesystem except under `/tmp`.

# ---------------------------------------------------------------------------
# Stage 1: build
# ---------------------------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /app

# `npm ci` needs only the manifests, so keep them in their own layer: a source
# change then reuses the cached dependency layer.
COPY package.json package-lock.json ./
RUN npm ci

# The build only reads `src/` and `tsconfig*.json` (see `tsconfig.build.json`).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime

# `tini` reaps anything the Node process leaves behind and forwards signals, so
# `SIGTERM` reaches Node and the graceful shutdown in `src/server/main.ts`
# (close tunnels and sessions, then the listener) actually runs. `docker run
# --init` would do the same job, but baking it in means the image behaves the
# same under Compose, Swarm and a bare `docker run`.
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only: `ws`, the MCP SDK and their transitive deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output only — no `src/`, no dev dependencies.
COPY --from=build /app/dist ./dist

# `node` (uid 1000) is the unprivileged user that ships with the official image.
# The app binds port 8080 (>1024), so no root is needed for that either.
USER node

# The single port that carries `/mcp/<name>`, `/status`, `/healthz` and the
# `upgrade /tunnel` WebSocket (see `src/server/app.ts`).
EXPOSE 8080

# Liveness only: `/healthz` answers `{"status":"ok"}` without authentication, so
# the check needs no token. `start-period` covers the module-loading time.
# The URL assumes the default port: if you set `MCP_PROXY_PORT` to something
# else, override the healthcheck in `deploy/docker-compose.yml`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server/main.js"]
