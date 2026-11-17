<#
.SYNOPSIS
    Registers the MCP WebSocket Proxy client as a Task Scheduler task for the
    current user, so the work PC starts exposing its local MCP servers at logon
    and keeps trying after a crash.

.DESCRIPTION
    Creates (or replaces, with -Force) the task "McpWebsocketProxyClient":

      trigger    At log on, for the current user only, plus a repeat every
                 5 minutes indefinitely (see $RepeatTrigger below)
      action     node <RepoRoot>\dist\client\main.js --config <ConfigPath>
      settings   hidden in the Task Scheduler UI, no instance limit override (a
                 second start is ignored), restart on failure: 3 attempts, 1
                 minute apart, no execution time limit (the agent is meant to
                 run forever)

    By default the task is registered with LogonType S4U ("run whether the user
    is logged on or not", no stored password): it then runs in its own session,
    so logging off does not kill it and logging back on does not start a second
    copy. S4U needs the "Replace a process level token" right; if registration
    fails because of that, re-run with -LogonType Interactive (the task then
    lives and dies with the desktop session, and the At log on trigger brings it
    back at the next logon).

    Run this once, from an ordinary (non-elevated) PowerShell:

      cd C:\repos\mcp-websocket-proxy
      npm ci
      npm run build
      .\scripts\install-task.ps1

    With explicit paths:

      .\scripts\install-task.ps1 -RepoRoot C:\repos\mcp-websocket-proxy `
                                 -ConfigPath C:\Users\me\AppData\Roaming\mcp-websocket-proxy\config.yaml

    Remove it again with .\scripts\uninstall-task.ps1.
    See docs/windows-client.md for the install steps and the smoke checklist.

.PARAMETER NodePath
    node.exe to run. Default: the node on PATH.

.PARAMETER RepoRoot
    Repository checkout that contains dist\client\main.js. Default: the parent
    of this script's folder (i.e. the repo this script lives in).

.PARAMETER ConfigPath
    Config file passed to --config. Default: %APPDATA%\mcp-websocket-proxy\config.yaml,
    the same default the client itself uses.

.PARAMETER TaskName
    Task Scheduler task name. Default: McpWebsocketProxyClient.

.PARAMETER LogonType
    S4U (default, survives logoff), Interactive (tied to the desktop session)
    or Password (requires -Credential).

.PARAMETER Credential
    Required with -LogonType Password: the user account Task Scheduler runs as.

.PARAMETER Force
    Replace the task when it already exists.
#>

[CmdletBinding()]
param(
    [string] $NodePath = '',
    [string] $RepoRoot = '',
    [string] $ConfigPath = '',
    [string] $TaskName = 'McpWebsocketProxyClient',
    [ValidateSet('S4U', 'Interactive', 'Password')]
    [string] $LogonType = 'S4U',
    [pscredential] $Credential,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'install-task.ps1 only runs on Windows.'
}

# --- defaults ----------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $onPath) {
        $onPath = Get-Command node -ErrorAction SilentlyContinue
    }
    if (-not $onPath) {
        throw 'node.exe was not found on PATH; install Node 24+ or pass -NodePath C:\path\to\node.exe'
    }
    $NodePath = $onPath.Source
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    # scripts\install-task.ps1 lives one level below the repository root.
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $env:APPDATA 'mcp-websocket-proxy\config.yaml'
}

$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$Entry = Join-Path $RepoRoot 'dist\client\main.js'
if (-not (Test-Path -LiteralPath $Entry)) {
    throw "cannot find $Entry - run `npm ci` and `npm run build` in $RepoRoot first."
}
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Warning "config file not found: $ConfigPath (copy config.example.yaml there, then start the task)"
} else {
    # Fail here rather than in a hidden task that retries three times and gives up.
    & $NodePath $Entry --config $ConfigPath --check
    if ($LASTEXITCODE -ne 0) {
        throw "the config did not pass --check (exit $LASTEXITCODE): $ConfigPath"
    }
}

# --- task definition ---------------------------------------------------------

$ArgumentList = @("`"$Entry`"", '--config', "`"$ConfigPath`"")
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument $ArgumentList -WorkingDirectory $RepoRoot

$UserId = "$env:USERDOMAIN\$env:USERNAME"
$AtLogOnTrigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId

# A second, recurring trigger: every 5 minutes, forever. On its own it would
# start a second copy every 5 minutes, but MultipleInstances IgnoreNew (below)
# makes every one of those ticks a no-op while the agent is alive - so each tick
# is instead a watchdog that brings the agent back. That is what makes the
# restart-on-failure policy dependable: Task Scheduler's own restart attempts
# stop after RestartCount, this repeat never does.
#
# Duration must be a plain TimeSpan: [TimeSpan]::MaxValue is rejected when the
# task XML is serialised, so 9999 days (~27 years) stands in for "indefinitely".
$RepeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 9999)
$Trigger = @($AtLogOnTrigger, $RepeatTrigger)

# -Hidden hides the task in the Task Scheduler UI; it does not hide a console
# window. With LogonType S4U the task runs in its own session so no window ever
# appears. With the -LogonType Interactive fallback a console window does show
# for the duration of the run; to keep that one off screen, run the action as
#   conhost.exe --headless node.exe <Entry> --config <ConfigPath>
# (Windows 11 22H2 and newer) instead of node.exe directly.
# RestartCount/RestartInterval: the crash policy.
# MultipleInstances IgnoreNew: "do not start a new instance if one is already
# running".
$Settings = New-ScheduledTaskSettingsSet `
    -Hidden `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

if ($LogonType -eq 'Password') {
    if (-not $Credential) {
        throw '-LogonType Password needs -Credential.'
    }
    $UserId = "$($Credential.UserName)"
    $Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Password -RunLevel Limited
} else {
    $Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType $LogonType -RunLevel Limited
}

# The logon type the task actually ends up registered with; S4U falls back to
# Interactive below when registration is refused.
$EffectiveLogonType = $LogonType

$Description = 'MCP WebSocket Proxy client: exposes this PC''s local MCP servers to Warren over an outbound tunnel.'

# --- register ----------------------------------------------------------------

$common = @{
    TaskName    = $TaskName
    Action      = $Action
    Trigger     = $Trigger
    Settings    = $Settings
    Description = $Description
}
if ($Force) {
    $common['Force'] = $true
}

try {
    if ($LogonType -eq 'Password') {
        $task = Register-ScheduledTask @common -User $UserId -Password $Credential.GetNetworkCredential().Password
    } else {
        $task = Register-ScheduledTask @common -Principal $Principal
    }
} catch {
    if ($LogonType -ne 'S4U') {
        throw
    }
    Write-Warning "S4U registration failed ($($_.Exception.Message)); retrying with -LogonType Interactive."
    Write-Warning 'The task will then stop at logoff and start again at the next logon.'
    $Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
    $task = Register-ScheduledTask @common -Principal $Principal
}

Write-Host "registered '$TaskName'"
Write-Host "  run:      $($Action.Execute) $($ArgumentList -join ' ')"
Write-Host "  trigger:  at log on ($UserId), restart on failure: 3x / 1 min"
Write-Host "  logon:    $LogonType"
Write-Host "start it now with:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "check it with:      Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
