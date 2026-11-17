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

- **trigger** at log on, current user only, **plus a repeat every 5 minutes**
  indefinitely — with "do not start a new instance" that repeat is a watchdog:
  every tick is a no-op while the agent runs and a restart when it does not;
- **action** `node <RepoRoot>\dist\client\main.js --config <ConfigPath>`;
- **hidden** in the Task Scheduler UI (with the default `Interactive` logon type a
  console window appears for the duration of the run; see Troubleshooting);
- **restart on failure**: 3 attempts, 1 minute apart;
- **no execution time limit** — Task Scheduler never kills a healthy agent;
- **"do not start a new instance if one is running"**, so a second logon cannot
  double-start it.

By default the task is registered with logon type `Interactive` and run level
`Limited`: it runs as you, only while you are logged on, with normal user
privileges — **no administrator rights are needed**, so run the script from an
ordinary, non-elevated PowerShell. The task lives and dies with your desktop
session: it stops at logoff and the At-log-on trigger brings it back at the next
logon.

To keep the agent running after a logoff, register it with logon type `S4U`
("run whether the user is logged on or not", no stored password):

```powershell
.\scripts\install-task.ps1 -RunWhetherUserLoggedIn -Force
```

`S4U` can only be registered from an elevated (Administrator) PowerShell, so
**that switch is the only thing here that needs elevation**. From a non-elevated
prompt the script stops with access denied (`0x80070005`) and says so; drop the
switch to get the elevation-free `Interactive` task instead.

Useful parameters:

```powershell
.\scripts\install-task.ps1 -RepoRoot D:\repos\mcp-websocket-proxy `
                           -ConfigPath D:\mcp\config.yaml `
                           -NodePath C:\Program Files\nodejs\node.exe `
                           -Force          # replace an existing task
```

`install-task.ps1` runs `--check` on the config first and refuses to register a
file that does not validate. It also verifies the task really exists before it
prints the `registered '...'` summary, so a failed registration is reported as
an error instead of a success. Remove the task again with:

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
4. **It comes back after logoff/logon.** With the default `Interactive` task the
   session always ends at logoff, so the agent always stops and restarts at the
   next logon: log off, log back in, then
   `tasklist /FI "IMAGENAME eq node.exe"` — the agent (and its children) are
   running again, exactly one copy, and the log shows a fresh `starting` line.
   Only with `-RunWhetherUserLoggedIn` (`S4U`) does the agent survive the logoff
   itself; there the log gets no new `starting` line because the process was
   never stopped.
5. **No orphan `node.exe` after a stop.** Note the pids from step 3, then
   `Stop-ScheduledTask -TaskName McpWebsocketProxyClient` and re-check:

   ```powershell
   tasklist /FI "IMAGENAME eq node.exe" /FO TABLE
   ```

   Nothing from the agent's tree may remain — in particular no `node.exe` whose
   parent was the `npx.cmd` shim. Stopping a scheduled task does **not** deliver
   a signal: Task Scheduler terminates the agent, so the client's own shutdown
   code never runs and the children are cleaned up because their stdin pipe
   closes — an MCP stdio server exits on stdin EOF. The `taskkill /T /F /PID <pid>`
   tree kill (which is what stops an `npx.cmd` shim from orphaning its `node.exe`
   grandchild) runs on the **foreground** path — the Ctrl+C run in
   "Validate before running" above. Check both: Ctrl+C a foreground run and
   `Stop-ScheduledTask` the task, and in neither case may a `node.exe` survive.
   If one does, note its pid and parent pid (`tasklist /V` / Task Manager →
   Details → "Parent process") and report it.
6. **It restarts after a crash.** `taskkill /PID <agent-pid> /F`, wait a minute:
   Task Scheduler restarts it (up to 3 times) and the log shows a new `starting`.
   This is now also covered by the 5-minute repeat trigger: even after the 3
   scheduled restart attempts are used up, the next tick within 5 minutes starts
   the agent again.

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

**`Register-ScheduledTask : Zugriff verweigert` / `Access denied` (`0x80070005`)**
You passed `-RunWhetherUserLoggedIn` (or `-LogonType S4U`) from a non-elevated
prompt. `S4U` can only be registered from an elevated (Administrator)
PowerShell. Either run the script from an elevated (Administrator) PowerShell,
or drop the switch and register the default `Interactive` task, which needs no
elevation.

**The task registered with `S4U` but never runs (`LastTaskResult: 0x80070569`)**
`0x80070569` is `LOGON_FAILURE`: registration succeeded, but the account lacks
the "Log on as a batch job" user right, so the run-time logon fails. Group
policy on a work PC usually grants it or withholds it, and it is not something a
non-elevated prompt can change. Re-register on the interactive session:

```powershell
.\scripts\install-task.ps1 -Force
```

The task then lives and dies with your desktop session: it stops at logoff and
the At-log-on trigger brings it back at the next logon.

**Roots on a share or a mapped drive do not work under `S4U`**
`S4U` gives the task a token but **no network credentials**: it authenticates
locally only. A `filesystem.roots` entry (or a server's working directory) on
`smb://server/share` or a mapped drive letter therefore fails with a permission
or "path not found" error, even though the same path works in your shell —
mapped drive letters in particular are per-session and do not exist in the task's
session. Keep roots on local paths, or run with the default `Interactive` logon
type (or `-LogonType Password` with `-Credential`) when a share must be reached.

**A console window appears when the task runs**
That is the default: the task is registered as `Interactive`, and `-Hidden` only
hides the task in the Task Scheduler UI, not a window — an interactive task shows
a console for the whole run. Under `S4U` (`-RunWhetherUserLoggedIn`, elevated) the
task runs in its own session and no window ever appears. To keep the window off
screen in the interactive case, register the action as
`conhost.exe --headless node.exe …` (Windows 11 22H2+), or accept the window —
closing it kills the agent.

**Uninstall**
`.\scripts\uninstall-task.ps1`, then kill any client process still running
(`tasklist` / Task Manager). The config file and log file are left alone.
