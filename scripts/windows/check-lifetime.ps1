<#
.SYNOPSIS
  P00-S01 WSL lifetime check: does the coordinator survive when no Windows terminal or wsl.exe client is open?

.DESCRIPTION
  Phase Record: makes sure the coordinator runs and records its identity.
  Then close EVERY WSL terminal, VS Code WSL window, and other wsl.exe user. In a fresh PowerShell, run
  `wsl.exe --list --running` every few minutes (it does not start the distro) and wait well past the idle
  timeout - at least 5 minutes, or until the distro is no longer listed.
  Phase Verify: compares the coordinator identity. If it changed, the distro was shut down and a keep-alive
  is needed (see start-keepalive.ps1).

.EXAMPLE
  .\check-lifetime.ps1 -Distro Ubuntu -Phase Record
  .\check-lifetime.ps1 -Distro Ubuntu -Phase Verify
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Distro,
    [Parameter(Mandatory = $true)][ValidateSet('Record', 'Verify')][string]$Phase,
    [string]$EntryPath,
    [string]$StateFile = (Join-Path $env:TEMP 'agent-studio-lifetime.json'),
    [string]$OutFile = (Join-Path (Get-Location) 'lifetime-evidence.json')
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AgentStudioWsl.psm1') -Force
$entry = Resolve-AgentStudioEntry $Distro $EntryPath

if ($Phase -eq 'Record') {
    $h = (Invoke-AgentStudio $Distro $entry @('health')).Response.data
    if (-not $h.coordinator.running) {
        $s = (Invoke-AgentStudio $Distro $entry @('coordinator', 'start')).Response
        if (-not $s.ok) { throw "coordinator start failed: $($s.error.message)" }
        $h = (Invoke-AgentStudio $Distro $entry @('health')).Response.data
    }
    $record = [ordered]@{ distro = $Distro; recordedAt = (Get-Date).ToUniversalTime().ToString('o')
                          pid = $h.coordinator.pid; startTime = $h.coordinator.startTime; keepAliveActive = [bool]$h.keepAlive.active }
    $record | ConvertTo-Json | Out-File -FilePath $StateFile -Encoding utf8
    Write-Host "Recorded coordinator pid $($record.pid) (keep-alive active: $($record.keepAliveActive))."
    Write-Host 'Now close every WSL terminal/VS Code WSL window, wait at least 5 minutes (check with: wsl.exe --list --running),'
    Write-Host "then run: .\check-lifetime.ps1 -Distro $Distro -Phase Verify"
    exit 0
}

$record = Get-Content -Raw -Path $StateFile | ConvertFrom-Json
$h = (Invoke-AgentStudio $Distro $entry @('health')).Response.data
$survived = [bool]($h.coordinator.running -and $h.coordinator.pid -eq $record.pid -and $h.coordinator.startTime -eq $record.startTime)
$result = [ordered]@{ distro = $Distro; recordedAt = $record.recordedAt; verifiedAt = (Get-Date).ToUniversalTime().ToString('o')
                      keepAliveActiveAtRecord = $record.keepAliveActive; keepAliveActiveNow = [bool]$h.keepAlive.active
                      pidBefore = $record.pid; pidAfter = $h.coordinator.pid; survived = $survived }
$result | ConvertTo-Json | Out-File -FilePath $OutFile -Encoding utf8
if ($survived) {
    Write-Host "SURVIVED: coordinator pid $($record.pid) is still running." -ForegroundColor Green
    exit 0
}
Write-Host 'NOT SURVIVED: the coordinator was restarted or stopped, so the distro was shut down while idle.' -ForegroundColor Yellow
Write-Host "Start a keep-alive (.\start-keepalive.ps1 -Distro $Distro), then repeat Record/Verify to confirm it works."
exit 1
