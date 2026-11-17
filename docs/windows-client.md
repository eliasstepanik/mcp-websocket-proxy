# Running the client on a Windows work PC

The client is the half of mcp-websocket-proxy that runs on the work PC: it starts
the local stdio MCP servers named in the config file and dials out to Warren over
a single WebSocket tunnel. This page is the Windows-specific part — installing it,
running it as a scheduled task, and what to look at when it does not work.

Everything below assumes Windows 10/11, Node.js **24 or newer** on `PATH`, and a
checkout of this repository (e.g. `C:\repos\mcp-websocket-proxy`). PowerShell
commands are run from an ordinary, non-elevated prompt: the task is registered for
the current user only and needs no administrator rights.

## Install

```powershell
cd C:\repos\mcp-websocket-proxy
npm ci
npm run build
```

`npm run build` produces `dist\client\main.js`, which is what the scheduled task
runs. Re-run it after every `git pull`.

### 1. Environment variables

The config file may reference the environment with `${env:VAR}`; the values
themselves should never be written into the file. Set them for your user account
(so the scheduled task, which runs as you, sees them):

```powershell
setx MCP_PROXY_CLIENT_TOKEN "<token from the Warren operator>"
setx DATABASE_URL "postgres://..."   # only if a server entry needs it
```

`setx` only affects **new** processes: open a fresh PowerShell to check, and
re-register/restart the task afterwards so it picks the value up.

### 2. Config file

Default location: `%APPDATA%\mcp-websocket-proxy\config.yaml`.

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\mcp-websocket-proxy"
copy .\config.example.yaml "$env:APPDATA\mcp-websocket-proxy\config.yaml"
notepad "$env:APPDATA\mcp-websocket-proxy\config.yaml"
```

The things that usually need changing (see the comments in `config.example.yaml`
for the full list):

- `server.url` — the Warren tunnel endpoint, `wss://…`.
- `server.token` — keep it as `${env:MCP_PROXY_CLIENT_TOKEN}`.
- `clientId` — how the machine shows up on Warren's `GET /status`.
- `log.file` — an optional JSON-lines log; the token is scrubbed from every line.
- `filesystem.roots` and the `servers:` entries — what this PC exposes.

### 3. Validate before running

`--check` reads and validates the file and exits; it never starts a child process
and never touches the network:

```powershell
node .\dist\client\main.js --check
# config ok                                    -> exit 0
# config invalid: C:\Users\me\AppData\Roaming\...
# - server.token: environment variable MCP_PROXY_CLIENT_TOKEN is not set
#                                                -> exit 1
```

Add `--config <path>` to test a different file. Then try one real foreground run
before installing the task — you see the JSON log lines directly:

```powershell
node .\dist\client\main.js
# Ctrl+C stops it (SIGINT is handled: tunnel closed, children stopped, exit 0)
```

### 4. Register the scheduled task

```powershell
.\scripts\install-task.ps1
```

That registers `McpWebsocketProxyClient` for the current user:

- **trigger** at log on, current user only;
- **action** `node <RepoRoot>\dist\client\main.js --config <ConfigPath>`;
- **hidden**, no console window;
- **restart on failure**: 3 attempts, 1 minute apart;
- **no execution time limit** — Task Scheduler never kills a healthy agent;
- **"do not start a new instance if one is running"**, so a second logon cannot
  double-start it.

By default the task is registered with logon type `S4U` ("run whether the user is
logged on or not", no stored password), which is what makes it survive a logoff.
If your machine policy denies that, the script says so and retries with
`-LogonType Interactive`; the task then stops at logoff and comes back at the
next logon.

Useful parameters:

```powershell
.\scripts\install-task.ps1 -RepoRoot D:\repos\mcp-websocket-proxy `
                           -ConfigPath D:\mcp\config.yaml `
                           -NodePath C:\Program Files\nodejs\node.exe `
                           -Force          # replace an existing task
```

`install-task.ps1` runs `--check` on the config first and refuses to register a
file that does not validate. Remove the task again with:

```powershell
.\scripts\uninstall-task.ps1
```

Start/stop/inspect it any time with:

```powershell
Start-ScheduledTask      -TaskName McpWebsocketProxyClient
Stop-ScheduledTask       -TaskName McpWebsocketProxyClient
Get-ScheduledTask        -TaskName McpWebsocketProxyClient | Get-ScheduledTaskInfo
```

## Manual smoke checklist

Run through this once after installing, and again after any change to the config.

1. **The task is running.**
   `Get-ScheduledTask -TaskName McpWebsocketProxyClient | Get-ScheduledTaskInfo`
   → `State: Running`, `LastTaskResult: 0` (or `267009` = still running).
2. **The agent started and dialed out.** With a `log.file` configured, it contains
   `{"level":"info","message":"starting",...}` and no `error` line; Warren's
   `GET /status` lists this `clientId` with the servers from the config.
3. **An `npx` server really starts.** Configure a `servers:` entry with
   `command: npx` (e.g. `@modelcontextprotocol/server-memory`), then from the
   Warren side call one of its tools. On the PC, `tasklist /FI "IMAGENAME eq node.exe" /V`
   shows the `npx` child (and the `node.exe` it launched) while the agent runs.
4. **It survives logoff/logon.** Log off, log back in, then
   `tasklist /FI "IMAGENAME eq node.exe"` — the agent (and its children) are
   running again, exactly one copy, and the log shows a fresh `starting` line
   only if the session actually ended.
5. **No orphan `node.exe` after a stop.** Note the pids from step 3, then
   `Stop-ScheduledTask -TaskName McpWebsocketProxyClient` and re-check:

   ```powershell
   tasklist /FI "IMAGENAME eq node.exe" /FO TABLE
   ```

   Nothing from the agent's tree may remain — in particular no `node.exe` whose
   parent was the `npx.cmd` shim. On Windows the client kills each child's whole
   process tree with `taskkill /T /F /PID <pid>` during shutdown precisely so an
   `npx.cmd` shim cannot leave its `node.exe` grandchild behind; if you see a
   leftover, note its pid and parent pid (`tasklist /V` / Task Manager → Details
   → "Parent process") and report it.
6. **It restarts after a crash.** `taskkill /PID <agent-pid> /F`, wait a minute:
   Task Scheduler restarts it (up to 3 times) and the log shows a new `starting`.

## Troubleshooting

**`401` in the log / the tunnel never comes up**
The upgrade request was rejected: the client token is wrong, expired, or the one
Warren was configured with. `setx` values only reach *new* processes — check the
value the running process actually sees (`echo $env:MCP_PROXY_CLIENT_TOKEN` in a
shell started after the `setx`), restart the task, and confirm the token with the
Warren operator. The client logs the 401 once and keeps retrying every 60s; the
token never appears in a log line, even in an echoed error.

**`server.url uses unencrypted ws:// for host "..."`**
The config validator refuses plain `ws://` for anything that is not localhost,
because the token travels in an upgrade header. Use `wss://`. If the endpoint
genuinely sits on a network you control (a VPN, a lab bench), set
`server.allowInsecure: true` — and only there.

**`config error: ...` / exit code 1 at startup**
Run `node .\dist\client\main.js --config <path> --check`: it prints every problem
it found, one per line, and names the environment variable that is missing
(never its value). Common causes: a missing `setx`, a `servers:` entry whose
`command` is not on the task's `PATH`, `filesystem.enabled: true` with no
`roots`, or a name collision between `filesystem.name` and a `servers:` key.

**The task runs but nothing is exposed**
`command: npx` needs `npx` on the `PATH` of the account the task runs as and
either network access or a warm npm cache. Test the exact command from a shell
that has the same environment, or install the package and point `command` at
`node` with the package's entry script. A child that cannot start is logged as
`local server failed to start` and retried with backoff; the other servers keep
running.

**Nothing in the log file**
`log.file` is optional — without it the agent logs to stderr, which a hidden task
discards. Set `log.file` to an absolute path inside a directory your user can
write (e.g. `%LOCALAPPDATA%\mcp-websocket-proxy\client.log`); it rotates at
10 MiB keeping one backup.

**Two copies of the agent**
Should not happen (the task ignores a second start). If it does — e.g. a
foreground run next to the task — stop one: the tunnel accepts both, but each
`npx` child is started twice and the servers appear twice on `GET /status`.

**Uninstall**
`.\scripts\uninstall-task.ps1`, then kill any client process still running
(`tasklist` / Task Manager). The config file and log file are left alone.
