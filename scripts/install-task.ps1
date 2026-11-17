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

    By default the task is registered with LogonType Interactive and RunLevel
    Limited: it runs as you, only while you are logged on, with normal user
    privileges, so no administrator rights are needed - an ordinary,
    non-elevated PowerShell is enough. The task then lives and dies with the
    desktop session, and the At log on trigger brings it back at the next logon.

    Pass -RunWhetherUserLoggedIn to register with LogonType S4U instead ("run
    whether the user is logged on or not", no stored password): the task then
    runs in its own session, so logging off does not kill it and logging back on
    does not start a second copy. S4U can only be registered from an elevated
    (Administrator) PowerShell, so that switch needs elevation. Without it
    registration fails with "Access denied" (0x80070005); drop the switch to get
    the default Interactive task.

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
    Interactive (default: tied to the desktop session, needs no elevation), S4U
    (survives logoff, needs an elevated shell) or Password (requires
    -Credential). -RunWhetherUserLoggedIn is a shortcut for S4U.

.PARAMETER RunWhetherUserLoggedIn
    Register with LogonType S4U ("run whether the user is logged on or not", no
    stored password), so the task survives a logoff. S4U can only be registered
    from an elevated (Administrator) PowerShell; from a non-elevated prompt
    registration fails with access denied (0x80070005). Optional - the default
    Interactive task needs no elevation.

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
    [string] $LogonType = 'Interactive',
    [switch] $RunWhetherUserLoggedIn,
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
    $NodePath = [string] $onPath.Source
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    # scripts\install-task.ps1 lives one level below the repository root.
    $RepoRoot = [string] (Split-Path -Parent $PSScriptRoot)
}

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = [string] (Join-Path $env:APPDATA 'mcp-websocket-proxy\config.yaml')
}

# New-ScheduledTaskAction takes plain [string] for -Execute, -Argument and
# -WorkingDirectory; keep everything a System.String so no FileInfo/DirectoryInfo
# ever reaches the cmdlet (PowerShell 5.1 cannot coerce those and fails with
# ParameterBindingArgumentTransformationException).
$NodePath = [string] (Resolve-Path -LiteralPath $NodePath).Path
$RepoRoot = [string] (Resolve-Path -LiteralPath $RepoRoot).Path
$ConfigPath = [string] $ConfigPath

$Entry = [string] (Join-Path $RepoRoot 'dist\client\main.js')
if (-not (Test-Path -LiteralPath $Entry)) {
    throw "cannot find $Entry - run 'npm ci' and 'npm run build' in $RepoRoot first."
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

# -Argument must be ONE double-quoted string, not an array: New-ScheduledTaskAction
# -Argument is typed [string] and an array (or a non-string object) fails to bind
# on PowerShell 5.1. Every path is wrapped in embedded quotes so paths with spaces
# (e.g. C:\Users\me\OneDrive - Volkswagen AG\repo) survive.
$ArgumentString = '"' + $Entry + '" --config "' + $ConfigPath + '"'
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument $ArgumentString -WorkingDirectory ([string] $RepoRoot)

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
# window. With the default LogonType Interactive a console window does show for
# the duration of the run; to keep that one off screen, run the action as
#   conhost.exe --headless node.exe <Entry> --config <ConfigPath>
# (Windows 11 22H2 and newer) instead of node.exe directly. With -RunWhetherUserLoggedIn
# (LogonType S4U) the task runs in its own session so no window ever appears.
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

if ($RunWhetherUserLoggedIn -and $PSBoundParameters.ContainsKey('LogonType') -and $LogonType -ne 'S4U') {
    throw "-RunWhetherUserLoggedIn means LogonType S4U; it cannot be combined with -LogonType $LogonType."
}

if ($RunWhetherUserLoggedIn) {
    # Opt-in: S4U ("run whether the user is logged on or not"). Can only be
    # registered from an elevated (Administrator) PowerShell.
    $LogonType = 'S4U'
}

if ($LogonType -eq 'Password') {
    if (-not $Credential) {
        throw '-LogonType Password needs -Credential.'
    }
    $UserId = "$($Credential.UserName)"
    $Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Password -RunLevel Limited
} else {
    $Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType $LogonType -RunLevel Limited
}

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

# -ErrorAction Stop so a failed registration becomes a terminating error even if
# the caller relaxed $ErrorActionPreference; nothing below may run on failure.
try {
    if ($LogonType -eq 'Password') {
        $task = Register-ScheduledTask @common -User $UserId -Password $Credential.GetNetworkCredential().Password -ErrorAction Stop
    } else {
        $task = Register-ScheduledTask @common -Principal $Principal -ErrorAction Stop
    }
} catch {
    if ($LogonType -eq 'S4U') {
        throw "registering '$TaskName' with LogonType S4U failed: $($_.Exception.Message)`nS4U ('run whether the user is logged on or not') can only be registered from an elevated (Administrator) PowerShell. Drop -RunWhetherUserLoggedIn (or pass -LogonType Interactive) to register the task as Interactive instead - that needs no elevation; the task then stops at logoff and the At log on trigger starts it again at the next logon."
    }
    throw "registering '$TaskName' failed: $($_.Exception.Message)"
}

# Never report success on a task that is not there.
$task = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    throw "Register-ScheduledTask returned but 'Get-ScheduledTask -TaskName $TaskName' finds nothing; the task was not registered."
}

# The logon type the task was actually registered with, read back from the task.
$EffectiveLogonType = [string] $task.Principal.LogonType

Write-Host "registered '$TaskName'"
Write-Host "  run:      $($Action.Execute) $ArgumentString"
Write-Host "  trigger:  at log on ($UserId) + every 5 min, restart on failure: 3x / 1 min"
Write-Host "  logon:    $EffectiveLogonType"
Write-Host "start it now with:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "check it with:      Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
