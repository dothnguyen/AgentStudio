<#
.SYNOPSIS
  P00-S01 Windows<->WSL boundary spike. Proves a Windows process can drive the Agent Studio backend through
  one fixed `wsl.exe --exec` entry point with JSON over stdio, byte-exact, and that the backend survives
  the Windows caller exiting.

.EXAMPLE
  .\boundary-spike.ps1 -Distro Ubuntu
  .\boundary-spike.ps1 -Distro Ubuntu-24.04 -Count 200 -OutFile .\evidence\s01-boundary.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Distro,
    [string]$EntryPath,
    [int]$Count = 100,
    [int]$OneShotSamples = 10,
    [string]$OutFile = (Join-Path (Get-Location) 'boundary-spike-evidence.json'),
    [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'AgentStudioWsl.psm1') -Force

$failures = New-Object System.Collections.Generic.List[string]
function Fail([string]$m) { $failures.Add($m); Write-Host "FAIL  $m" -ForegroundColor Red }
function Pass([string]$m) { Write-Host "PASS  $m" -ForegroundColor Green }

$entry = Resolve-AgentStudioEntry $Distro $EntryPath
Write-Host "Distro: $Distro   Entry: $entry   PowerShell: $($PSVersionTable.PSVersion)"
$evidence = [ordered]@{ recordedAt = (Get-Date).ToUniversalTime().ToString('o'); distro = $Distro; entry = $entry
                        powershell = "$($PSVersionTable.PSVersion) $($PSVersionTable.PSEdition)"; os = [Environment]::OSVersion.VersionString }

# 1. One-shot health ------------------------------------------------------------------------------
$h = Invoke-AgentStudio $Distro $entry @('health')
if (-not $h.Response.ok) { throw "health failed: $($h.Raw.Stdout)" }
$evidence.healthBefore = $h.Response.data
Pass "one-shot health ($($h.ElapsedMs) ms); WSL $($h.Response.data.wsl.version), python $($h.Response.data.python)"

# 2. Coordinator with debug commands ------------------------------------------------------------
$coord = $h.Response.data.coordinator
if ($coord.running -and -not $coord.debugCommands) {
    if ($NoRestart) { throw 'Coordinator is running without --enable-debug; rerun without -NoRestart or restart it yourself.' }
    Write-Warning 'Restarting the coordinator with --enable-debug for the spike.'
    $null = Invoke-AgentStudio $Distro $entry @('coordinator', 'stop')
    $coord = $null
}
if (-not $coord -or -not $coord.running) {
    $s = Invoke-AgentStudio $Distro $entry @('coordinator', 'start', '--enable-debug')
    if (-not $s.Response.ok) { throw "coordinator start failed: $($s.Raw.Stdout) $($s.Raw.Stderr)" }
    $coord = $s.Response.data
    Pass "coordinator started (pid $($coord.pid)) in $($s.ElapsedMs) ms"
}
$evidence.coordinator = $coord

# 3. One-shot `request` with hostile payloads (stdin JSON, nothing on the command line) ----------
$hostile = Get-HostileStrings
$oneShotOk = 0
foreach ($text in $hostile) {
    $r = Invoke-AgentStudioRequest $Distro $entry @{ command = 'debug.echo'; idempotencyKey = (New-IdempotencyKey 'oneshot'); args = @{ text = $text } }
    if ($r.Response.ok -and $r.Response.data.text -ceq $text -and $r.Response.data.sha256 -eq (Get-Sha256Hex $text)) { $oneShotOk++ }
    else { Fail "one-shot echo mismatch for payload: $($text.Substring(0, [math]::Min(40, $text.Length)))" }
}
if ($oneShotOk -eq $hostile.Count) { Pass "one-shot request: $oneShotOk/$($hostile.Count) hostile payloads byte-exact" }
$evidence.oneShotEcho = @{ total = $hostile.Count; exact = $oneShotOk }

# 4. One-shot latency ---------------------------------------------------------------------------
$samples = @()
for ($i = 0; $i -lt $OneShotSamples; $i++) { $samples += (Invoke-AgentStudio $Distro $entry @('health')).ElapsedMs }
$evidence.oneShotLatencyMs = @{ samples = $OneShotSamples; median = (Get-Percentile $samples 0.5); p95 = (Get-Percentile $samples 0.95) }
Pass "one-shot health latency: median $($evidence.oneShotLatencyMs.median) ms, p95 $($evidence.oneShotLatencyMs.p95) ms"

# 5. serve session: $Count echoes, a malformed line, and session continuity ----------------------
$session = Start-AgentStudioServe $Distro $entry
try {
    $first = Send-ServeRequest $session @{ id = 0; command = 'health' }
    if (-not $first.Response.ok) { throw 'serve health failed' }
    $times = @(); $exact = 0
    for ($i = 1; $i -le $Count; $i++) {
        $text = $hostile[$i % $hostile.Count] + " #$i"
        $res = Send-ServeRequest $session @{ id = $i; command = 'debug.echo'; idempotencyKey = (New-IdempotencyKey 'serve'); args = @{ text = $text } }
        $times += $res.ElapsedMs
        $d = $res.Response
        if ($d.id -eq $i -and $d.ok -and $d.data.text -ceq $text -and $d.data.sha256 -eq (Get-Sha256Hex $text)) { $exact++ }
        else { Fail "serve echo #$i mismatch: $($res.Line.Substring(0, [math]::Min(200, $res.Line.Length)))" }
    }
    if ($exact -eq $Count) { Pass "serve: $exact/$Count hostile echoes byte-exact with matching ids" }
    $evidence.serveEcho = @{ total = $Count; exact = $exact; latencyMs = @{ median = (Get-Percentile $times 0.5); p95 = (Get-Percentile $times 0.95) } }
    Pass "serve round-trip latency: median $($evidence.serveEcho.latencyMs.median) ms, p95 $($evidence.serveEcho.latencyMs.p95) ms"

    $bad = Send-ServeBytes $session ([System.Text.Encoding]::ASCII.GetBytes("{this is not json`n"))
    $after = Send-ServeRequest $session @{ id = 'after-bad-line'; command = 'health' }
    if (-not $bad.Response.ok -and $bad.Response.error.code -eq 'BAD_REQUEST' -and $after.Response.ok -and $after.Response.id -eq 'after-bad-line') {
        Pass 'serve rejected a malformed line with BAD_REQUEST and kept the session open'
    } else { Fail 'serve did not handle a malformed line correctly' }
    $evidence.serveMalformedLine = @{ code = $bad.Response.error.code; sessionContinued = [bool]$after.Response.ok }
} finally { Stop-AgentStudioServe $session }

# 6. Kill the Windows caller mid-session; coordinator must be unaffected ------------------------
$before = (Invoke-AgentStudio $Distro $entry @('health')).Response.data.coordinator
$victim = Start-AgentStudioServe $Distro $entry
$null = Send-ServeRequest $victim @{ id = 'pre-kill'; command = 'health' }
$victim.Process.Kill()
$victim.Process.WaitForExit(10000) | Out-Null
Start-Sleep -Seconds 2
$afterKill = (Invoke-AgentStudio $Distro $entry @('health')).Response.data.coordinator
$survived = $afterKill.running -and $afterKill.pid -eq $before.pid -and $afterKill.startTime -eq $before.startTime
if ($survived) { Pass "coordinator pid $($before.pid) unchanged after the wsl.exe caller was killed" }
else { Fail "coordinator changed or stopped after the caller was killed (before pid $($before.pid), after $($afterKill.pid))" }
$evidence.callerKill = @{ survived = [bool]$survived; pidBefore = $before.pid; pidAfter = $afterKill.pid }

# 7. Environment seen by the coordinator --------------------------------------------------------
$final = (Invoke-AgentStudio $Distro $entry @('health')).Response.data
$evidence.environment = $final.environment
$evidence.keepAlive = $final.keepAlive
Write-Host "Coordinator environment source: $($final.environment.envSource); Linux PATH dirs: $(@($final.environment.pathDirs.linux).Count)"

$evidence.failures = @($failures)
$evidence.passed = ($failures.Count -eq 0)
$evidence | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutFile -Encoding utf8
Write-Host "Evidence written to $OutFile"
if ($failures.Count -gt 0) { Write-Host "$($failures.Count) check(s) failed." -ForegroundColor Red; exit 1 }
Write-Host 'Boundary spike passed.' -ForegroundColor Green
exit 0
