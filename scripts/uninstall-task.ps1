<#
.SYNOPSIS
    Removes the Task Scheduler task created by scripts\install-task.ps1.

.DESCRIPTION
    Stops the task if it is running, then unregisters it. Nothing else is
    touched: the repository, the config file and any log file stay where they
    are. Run it from an ordinary (non-elevated) PowerShell:

      .\scripts\uninstall-task.ps1

    A different task name (or a task installed by another user) works too:

      .\scripts\uninstall-task.ps1 -TaskName McpWebsocketProxyClient

    Removing the task does not kill a client that is already running: stop it
    first (Task Scheduler "End", or `Stop-ScheduledTask`) if it must stop now.
    See docs/windows-client.md.

.PARAMETER TaskName
    Task Scheduler task name. Default: McpWebsocketProxyClient.
#>

[CmdletBinding()]
param(
    [string] $TaskName = 'McpWebsocketProxyClient'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'uninstall-task.ps1 only runs on Windows.'
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "no scheduled task named '$TaskName' - nothing to do."
    return
}

if ($task.State -eq 'Running') {
    Write-Host "stopping '$TaskName'..."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "unregistered '$TaskName'."
Write-Host 'note: a client process that was already running keeps running; end it in Task Manager if needed.'
