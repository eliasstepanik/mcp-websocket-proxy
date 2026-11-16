# mcp-websocket-proxy

Expose the MCP servers on a machine Warren cannot reach — a work PC behind NAT, a
laptop, a box with a VPN — as ordinary Streamable HTTP MCP endpoints that Warren
dials directly.

The work PC never accepts inbound connections. It dials **one** outbound WebSocket
to this proxy and keeps it open; Warren talks plain HTTPS to the proxy, and the
proxy relays JSON-RPC over the tunnel in both directions.

```
   Warren (backend)                server (this repo)                work PC
   ---------------                -------------------                -------

   warren.toml          HTTPS      Caddy (TLS)                 client (T5/T6)
   [mcp.work-fs]          |            |                        +--------------+
   url = .../mcp/         v            v                        | filesystem   |
     filesystem      +-----------------------+   wss /tunnel    | main.js      |
        |             | node dist/server/   |<-----------------|              |
        |  POST/GET   |   main.js  :8080    |  one outbound    +------+-------+
        v             |                     |   WebSocket             | stdio
   +----------+       |  /mcp/<name>        |                  +------+-------+
   |  SSE /   |------>|  /status /healthz   |                  | npx <stdio   |
   |  results |       |  upgrade /tunnel    |----------------->| MCP servers> |
   +----------+       +-----------------------+   JSON-RPC     +--------------+
                                                  over tunnel
```

Two bearer tokens keep the two directions apart (`src/server/config.ts`):

| Token                        | Authenticates                       | Used on                          |
| --------------------------- | ----------------------------------- | -------------------------------- |
| `MCP_PROXY_CLIENT_TOKEN`    | the work PC                          | `upgrade /tunnel`               |
| `MCP_PROXY_ENDPOINT_TOKEN`  | Warren                               | `/mcp/<name>`, `/status`        |

They must differ, and the server refuses to start when they are equal: a stolen
work-PC token must not be usable against the MCP endpoints (or vice versa).

## What runs where

| Piece          | Entry point                | Notes                                                    |
| -------------- | -------------------------- | -------------------------------------------------------- |
| Server         | `dist/server/main.js`      | one port: HTTP endpoints + the `/tunnel` WebSocket upgrade |
| Client         | `dist/client/main.js`      | YAML config, spawns the local stdio servers              |
| Client config  | `config.example.yaml`      | copy to `%APPDATA%\mcp-websocket-proxy\config.yaml`      |

## Quickstart: the server

The production deployment is a Docker Compose stack behind Caddy. There are no
published host ports — Caddy reaches the container over a shared Docker network.

### 1. Layout

```
/home/proxy/services/stacks/McpWebsocketProxy/
└── src/                # the repository (git clone)
    ├── Dockerfile
    └── deploy/
        ├── docker-compose.yml
        └── .env        # chmod 600, never committed
```

```bash
git clone <repo> /home/proxy/services/stacks/McpWebsocketProxy/src
```

`build.context` in `deploy/docker-compose.yml` is `..`, i.e. the repository root,
which is where the `Dockerfile` is. Everything below runs from
`/home/proxy/services/stacks/McpWebsocketProxy/src/deploy`.

### 2. Tokens

```bash
cd /home/proxy/services/stacks/McpWebsocketProxy/deploy
cp .env.example .env
chmod 600 .env
openssl rand -hex 32   # -> MCP_PROXY_CLIENT_TOKEN
openssl rand -hex 32   # -> MCP_PROXY_ENDPOINT_TOKEN
```

Paste the two values into `.env` (different values — the server exits otherwise).
`chmod 600` matters: this file holds the only secrets the deployment has.

### 3. Host name

`deploy/docker-compose.yml` ships with the placeholder host
`mcp-proxy.example.com` in the `caddy_0` label. Replace it with the hostname that
DNS points at your Caddy instance, and make sure the TLS block matches how your
Caddy gets certificates (the shipped `caddy_0.tls.dns` line uses a DNS-01
challenge with the `ionos` provider and reads `IONOS_TOKEN` from the same
`.env`; delete it for the default HTTP-01 challenge).

### 4. Start

```bash
docker compose --env-file .env up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/healthz   # only if you added a port; normally:
curl -fsS https://mcp-proxy.example.com/healthz
```

`/healthz` needs no token and is what the image's `HEALTHCHECK` polls. A
misconfigured environment makes the container exit immediately with a message
naming the offending variable (never its value) — `docker compose logs` shows it.

### 5. Caddy note

The container is only reachable from the `clustermanager_caddy` network, which
must already exist (it is created by the Caddy stack; `external: true` here).
`flush_interval: -1` on the reverse proxy is **required**: it disables response
buffering, and without it the SSE stream on `/mcp/<name>` and the `/tunnel`
WebSocket stall behind Caddy.

## Quickstart: the work PC

See [docs/windows-client.md](docs/windows-client.md) for the full Windows
runbook (install, `setx` for the token, config file, scheduled task,
troubleshooting). In short:

```powershell
npm ci; npm run build
setx MCP_PROXY_CLIENT_TOKEN "<MCP_PROXY_CLIENT_TOKEN from the server host>"
# config: %APPDATA%\mcp-websocket-proxy\config.yaml  (see config.example.yaml)
node dist\client\main.js --config "$env:APPDATA\mcp-websocket-proxy\config.yaml" --check
```

`server.url` is `wss://<your host>/tunnel`. `--check` validates the file without
starting anything. Each enabled server appears as `/mcp/<name>` on the proxy;
`GET /status` (with the endpoint token) lists connected clients and which of
their servers are `up`.

## Warren configuration

```toml
[mcp.work-fs]
transport = "http"
url = "https://mcp-proxy.example.com/mcp/filesystem"
run_in = "backend"
headers = { Authorization = "Bearer ${env:MCP_PROXY_ENDPOINT_TOKEN}" }
```

- The section name is what Warren prefixes tool names with (`work-fs.<tool>`);
  the **last path segment** of the URL is the proxied server name, and must match
  a name the client publishes (`filesystem` by default, `filesystem.name` in the
  client config).
- `run_in = "backend"`: the proxy is a network endpoint, so Warren must not try
  to supervise it as a local child process.
- The endpoint token lives in Warren's environment, not in `warren.toml`.
- **Note:** per-server `headers` support is being added to Warren. Until it
  lands, the endpoint token cannot be sent from `warren.toml`; either wait for
  it, or put a locally authenticating reverse proxy in front (or run Warren and
  the proxy on a trusted network and terminate the token there).

## Endpoint behaviour

Everything is on one port (default `8080`, `MCP_PROXY_PORT`).

| Request                                   | Result                                                                     |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `GET /healthz`                            | `200 {"status":"ok"}`, no auth. Other methods → `405` (`allow: GET`).      |
| `GET /status`                             | `200` `{clients:[{clientId,servers:[{name,up}]}],serverVersion}`; needs the endpoint token, else `401`. |
| `upgrade /tunnel`                         | WebSocket handshake; needs the client token, else a plain `401` (no handshake). Any other upgrade path → `404`. |
| `POST /mcp/<name>` `initialize`           | `200` + `Mcp-Session-Id`. `401` without/with a wrong endpoint token. `404` for a name outside `^[a-z0-9][a-z0-9_-]{0,62}$`. `503` + `retry-after: 10` when that server has no live tunnel. |
| `POST /mcp/<name>` with a session id      | Relayed to the tunnel. `404` for an unknown/expired session id, `400` when the header is missing. |
| `GET /mcp/<name>` (session id)            | Standalone SSE stream for notifications. `404`/`400` as above.             |
| `DELETE /mcp/<name>` (session id)         | Closes the session; the id then answers `404`.                             |
| `POST /mcp/<name>` with a bad `Accept`    | `406` (the MCP Streamable HTTP requirement: `application/json, text/event-stream`). |
| Anything else                             | `404` with a JSON-RPC error body.                                          |

`initialize` is answered **by the proxy** from the cached server capabilities, so
Warren can initialise without a round-trip through the tunnel. Everything else is
relayed. A server that goes down and comes back while Warren sessions are open
gets synthesised `notifications/*/list_changed` for the gap, because the upstream
was unreachable and could not send them.

## Errors

Proxy-originated failures always use JSON-RPC code **`-32050`** and carry
`data: { "source": "mcp-websocket-proxy", "reason": "<reason>" }`, so Warren can
tell a proxy failure from a real server failure. Upstream errors are relayed
unchanged (same code, message and data).

| Reason                | Meaning                                                    | Retry? |
| --------------------- | ---------------------------------------------------------- | ------ |
| `offline`             | no live tunnel for that server right now                    | yes    |
| `server_down`         | the tunnel is up, the local stdio server is not running     | yes    |
| `client_disconnected` | the tunnel dropped while the request was in flight          | yes    |
| `timeout`             | the request exceeded its deadline (`MCP_PROXY_REQUEST_TIMEOUT_MS`, default 300 s) | yes |
| `too_large`           | a message exceeded the size limit (`MCP_PROXY_MAX_MESSAGE_BYTES`, default 32 MiB; POST bodies 4 MiB) | no |

`offline` and `server_down` answer `initialize` with HTTP `503` and
`retry-after: 10` instead of a plain error, so a client that starts before the
work PC does simply succeeds a few seconds later.

Other HTTP/JSON-RPC statuses:

| Status | JSON-RPC code | When                                                        |
| ------ | ------------- | ----------------------------------------------------------- |
| `400`  | `-32700`      | body is not valid JSON / empty                              |
| `400`  | `-32000`      | `Mcp-Session-Id` header missing                             |
| `401`  | `-32000`      | missing or wrong bearer token (`www-authenticate: Bearer realm="mcp-proxy"`) |
| `404`  | `-32000`      | unknown route, invalid server name, unknown session id      |
| `405`  | `-32000`      | method not allowed on the route                             |
| `406`  | —             | `Accept` header does not satisfy Streamable HTTP            |
| `413`  | `-32050`      | body over the limit (`reason: too_large`)                   |
| `500`  | `-32603`      | unexpected proxy-side failure                               |
| `503`  | `-32050`      | `offline` / `server_down`, with `retry-after: 10`           |

## Configuration reference (server)

Required: `MCP_PROXY_CLIENT_TOKEN`, `MCP_PROXY_ENDPOINT_TOKEN` (≥ 32 characters,
must differ). Optional, with defaults:

| Variable                            | Default   | Meaning                              |
| ----------------------------------- | --------- | ------------------------------------ |
| `MCP_PROXY_PORT`                    | `8080`    | listen port (`0` = any free port)    |
| `MCP_PROXY_HOST`                    | `0.0.0.0` | bind address                         |
| `MCP_PROXY_HEARTBEAT_INTERVAL_MS`   | `15000`   | tunnel `ping` interval               |
| `MCP_PROXY_HEARTBEAT_TIMEOUT_MS`    | `30000`   | silence before a tunnel is declared dead (must be > interval) |
| `MCP_PROXY_REQUEST_TIMEOUT_MS`      | `300000`  | per-request relay deadline           |
| `MCP_PROXY_MAX_MESSAGE_BYTES`       | `33554432`| tunnel frame / declared body limit   |
| `MCP_PROXY_SESSION_IDLE_TTL_MS`     | `604800000` | idle Warren session TTL (7 days)   |
| `MCP_PROXY_LOG_LEVEL`               | `info`    | one of `debug`, `info`, `warn`, `error`                    |

Logging is one JSON line per request on stdout — `{method, path, status, ms}`
plus startup/shutdown lines. No params, no results, no headers, no tokens.

## Development

```bash
npm ci
npm run typecheck   # tsc --noEmit over src + test
npm test            # vitest run (spawns stdio children, binds sockets)
npm run build       # -> dist/
npm run dev:server  # tsx watch
npm run dev:client  # tsx watch
```

Requires Node.js **24 or newer**.

## Docs

- [docs/windows-client.md](docs/windows-client.md) — Windows install, scheduled task, smoke checklist, troubleshooting.
- [config.example.yaml](config.example.yaml) — annotated client config.
- [deploy/.env.example](deploy/.env.example) — server secrets.
- [Dockerfile](Dockerfile), [deploy/docker-compose.yml](deploy/docker-compose.yml) — packaging.
