<#
.SYNOPSIS
  Keeps the WSL distro alive by holding one hidden wsl.exe client running `agent-studio keepalive`.
  `agent-studio health` reports keepAlive.active when it is running.

.EXAMPLE
  .\start-keepalive.ps1 -Distro Ubuntu                    # start now (hidden)
  .\start-keepalive.ps1 -Distro Ubuntu -RegisterAtLogon   # also start at every Windows logon
  .\start-keepalive.ps1 -Distro Ubuntu -Unregister        # remove the logon task
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Distro,
    [string]$EntryPath,
    [switch]$RegisterAtLogon,
    [switch]$Unregister
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AgentStudioWsl.psm1') -Force
$entry = Resolve-AgentStudioEntry $Distro $EntryPath
$taskName = "AgentStudio WSL keep-alive ($Distro)"

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$taskName' (a running keep-alive stays up until you stop it or reboot)."
    exit 0
}

Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $Distro, '--exec', $entry, 'keepalive') -WindowStyle Hidden
Start-Sleep -Seconds 2
$h = (Invoke-AgentStudio $Distro $entry @('health')).Response.data
Write-Host "Keep-alive active: $($h.keepAlive.active)"

if ($RegisterAtLogon) {
    $inner = "Start-Process -FilePath wsl.exe -ArgumentList '-d','$Distro','--exec','$entry','keepalive' -WindowStyle Hidden"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$inner`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "Registered scheduled task '$taskName' (a PowerShell window may flash briefly at logon)."
}
