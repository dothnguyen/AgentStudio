<#
.SYNOPSIS
  Agent Studio bridge: runs allowlisted `agent-studio` commands in WSL for requests dropped into
  <workspace>\.agent-studio-bridge\requests, and writes the results to ...\responses.

.DESCRIPTION
  Lets a tool that can only read and write files in the project folder (for example a Claude session
  linked to this computer) use `agent-studio` indirectly. Nothing runs that is not on the allowlist below:
  each request names an agent-studio subcommand and its arguments as a JSON list, the bridge checks the
  subcommand, and runs `wsl.exe --cd <workspace> -e <agent-studio> <args...>` with no shell in between,
  so arguments are never interpreted as shell text. Read-only commands are allowed by default; commands
  that change state (approve, retry, move, cancel ...) need -AllowWrites.

  Start it in a PowerShell window and leave it running; Ctrl+C stops it. One bridge per workspace.

    powershell -ExecutionPolicy Bypass -File scripts\windows\as-bridge.ps1            # read-only
    powershell -ExecutionPolicy Bypass -File scripts\windows\as-bridge.ps1 -AllowWrites

  Request  (requests\<id>.json, written atomically; names starting with "." are ignored):
    {"id": "r1", "args": ["workflow", "show", "--workflow", "<run id>"]}
    {"id": "r2", "op": "diagnose", "key": "T-089"}       # scripts/diagnose_ticket.py, report on stdout
    {"id": "r3", "op": "log", "lines": 200}              # tail of the coordinator log
  Response (responses\<id>.json): {id, ok, exitCode, timedOut, stdout, stderr, durationMs, error, ...}
  status.json is rewritten every few seconds while the bridge runs; audit.txt lists every request.

.PARAMETER Workspace   The Agent Studio workspace (default: two folders above this script).
.PARAMETER Distro      WSL distro to use (default: the default distro).
.PARAMETER AllowWrites Also allow commands that change state.
.PARAMETER TimeoutSec  Per-command limit (default 120).
#>
param(
    [string]$Workspace = '',
    [string]$Distro = '',
    [switch]$AllowWrites,
    [ValidateRange(5, 1800)][int]$TimeoutSec = 120,
    [ValidateRange(100, 10000)][int]$PollMs = 500
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

if (-not $Workspace) { $Workspace = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$Workspace = (Resolve-Path $Workspace).Path.TrimEnd('\')
if (-not ($Workspace -match '^([A-Za-z]):\\')) { throw "Workspace must be a local drive path: $Workspace" }
$WslWorkspace = '/mnt/' + $Matches[1].ToLower() + '/' + ($Workspace.Substring(3) -replace '\\', '/')

$Bridge = Join-Path $Workspace '.agent-studio-bridge'
$ReqDir = Join-Path $Bridge 'requests'
$ResDir = Join-Path $Bridge 'responses'
foreach ($d in @($Bridge, $ReqDir, $ResDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
$Utf8 = New-Object System.Text.UTF8Encoding $false
$MaxOutput = 256KB

# ---- allowlist ------------------------------------------------------------------------------------------
# key = the subcommand words; value = 'read' or 'write'. Longest match wins ("board rules" before "board").
$Allow = @{
    'health' = 'read'; 'snapshot' = 'read'; 'events' = 'read'
    'task show' = 'read'
    'workflow show' = 'read'; 'workflow list' = 'read'; 'workflow validate' = 'read'
    'ticket show' = 'read'; 'ticket list' = 'read'
    'board show' = 'read'; 'board rules' = 'read'; 'board phase' = 'read'
    'team status' = 'read'; 'team list' = 'read'; 'team show' = 'read'; 'team validate' = 'read'
    'team blocked' = 'read'; 'team workflows' = 'read'; 'team check' = 'read'
    'command catalog' = 'read'; 'command requests' = 'read'
    'command approve' = 'write'; 'command reject' = 'write'; 'command cancel' = 'write'
    'ticket retry' = 'write'; 'ticket move' = 'write'; 'ticket unblock' = 'write'
    'ticket add' = 'write'; 'ticket depend' = 'write'
    'workflow retry' = 'write'; 'workflow cancel' = 'write'
    'assignment resolve' = 'write'; 'assignment cancel' = 'write'
    'board resume' = 'write'; 'team run-board' = 'write'; 'team stop-board' = 'write'
    'team resolve' = 'write'; 'team retry' = 'write'
}
# `board phase` only for its read actions
$BoardPhaseRead = @('list', 'show')
# arguments that make agent-studio read a file or stdin are never passed through
$BlockedArgs = '^--(text-file|body-file)(=|$)'

function ConvertTo-ArgString([string[]]$List) {
    # Windows command-line quoting (the rules CommandLineToArgvW and the C runtime use), so each element
    # arrives in WSL as exactly one argument.
    $parts = foreach ($a in $List) {
        if ($a -eq '') { '""'; continue }
        if ($a -notmatch '[\s"]') { $a; continue }
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('"')
        $bs = 0
        foreach ($ch in $a.ToCharArray()) {
            if ($ch -eq '\') { $bs++ }
            elseif ($ch -eq '"') { [void]$sb.Append('\' * ($bs * 2 + 1)); [void]$sb.Append('"'); $bs = 0 }
            else { if ($bs) { [void]$sb.Append('\' * $bs) }; $bs = 0; [void]$sb.Append($ch) }
        }
        [void]$sb.Append('\' * ($bs * 2))
        [void]$sb.Append('"')
        $sb.ToString()
    }
    return ($parts -join ' ')
}

function Invoke-Wsl([string[]]$Argv, [int]$Seconds) {
    $all = @()
    if ($Distro) { $all += @('-d', $Distro) }
    $all += @('--cd', $WslWorkspace, '-e') + $Argv
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl.exe'
    $psi.Arguments = ConvertTo-ArgString $all
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = $Utf8
    $psi.StandardErrorEncoding = $Utf8
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $timedOut = $false
    if (-not $p.WaitForExit($Seconds * 1000)) {
        $timedOut = $true
        try { $p.Kill() } catch { }
    }
    $p.WaitForExit()
    $out = $outTask.Result; $err = $errTask.Result
    $trunc = $false
    if ($out.Length -gt $MaxOutput) { $out = $out.Substring($out.Length - $MaxOutput); $trunc = $true }
    if ($err.Length -gt $MaxOutput) { $err = $err.Substring($err.Length - $MaxOutput); $trunc = $true }
    return [ordered]@{ exitCode = $(if ($timedOut) { $null } else { $p.ExitCode }); timedOut = $timedOut
        stdout = $out; stderr = $err; outputTruncated = $trunc; durationMs = [int]$sw.ElapsedMilliseconds }
}

function Write-JsonFile([string]$Path, $Object) {
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, ($Object | ConvertTo-Json -Depth 6), $Utf8)
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Get-Field($Obj, [string]$Name) {
    if ($null -ne $Obj -and $Obj.PSObject.Properties[$Name]) { return $Obj.$Name }
    return $null
}

# ---- resolve agent-studio inside WSL (fixed script, no request data) --------------------------------------
$probe = Invoke-Wsl @('bash', '-lc', 'command -v agent-studio || { test -x "$HOME/.local/bin/agent-studio" && echo "$HOME/.local/bin/agent-studio"; }') 60
$AgentStudio = ($probe.stdout -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
if (-not $AgentStudio) { throw "agent-studio was not found in WSL (exit $($probe.exitCode)): $($probe.stderr)" }
$AgentStudio = $AgentStudio.Trim()

# ---- one bridge per workspace -------------------------------------------------------------------------
$lockPath = Join-Path $Bridge 'bridge.lock'
try { $lock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw "Another bridge is already running for $Workspace." }

$started = (Get-Date).ToUniversalTime().ToString('o')
function Write-Status {
    Write-JsonFile (Join-Path $Bridge 'status.json') ([ordered]@{
        pid = $PID; startedAt = $started; lastSeen = (Get-Date).ToUniversalTime().ToString('o')
        allowWrites = [bool]$AllowWrites; distro = $Distro; agentStudio = $AgentStudio
        workspace = $Workspace; wslWorkspace = $WslWorkspace; timeoutSec = $TimeoutSec })
}

function Resolve-Request($Req) {
    # -> @{ argv = [...]; kind = 'read'|'write' } or throws with the reason
    $op = Get-Field $Req 'op'
    if ($op -eq 'diagnose') {
        $key = [string](Get-Field $Req 'key')
        if ($key -notmatch '^[A-Za-z][A-Za-z0-9]{0,15}-[0-9]{1,6}$') { throw "diagnose needs a ticket key like T-089" }
        return @{ argv = @('python3', 'scripts/diagnose_ticket.py', $key, '--out', '-'); kind = 'read' }
    }
    if ($op -eq 'log') {
        $n = 200
        $lines = Get-Field $Req 'lines'
        if ($null -ne $lines) { $n = [int]$lines }
        if ($n -lt 1 -or $n -gt 5000) { throw 'log lines must be 1..5000' }
        return @{ argv = @('bash', '-c', 'tail -n "$1" "${XDG_STATE_HOME:-$HOME/.local/state}/agent-studio/coordinator.log"',
                           'bridge-log', [string]$n); kind = 'read' }
    }
    if ($null -ne $op) { throw "unknown op '$op'" }
    $args_ = Get-Field $Req 'args'
    if ($null -eq $args_ -or @($args_).Count -lt 1 -or @($args_).Count -gt 40) { throw 'args must be a list of 1-40 strings' }
    $list = @()
    foreach ($a in @($args_)) {
        if ($a -isnot [string]) { throw 'every arg must be a string' }
        # line breaks are allowed (ticket bodies); NUL and carriage returns are not
        if ($a.Length -gt 32768 -or $a -match "[\x00\r]") { throw 'an arg is too long or holds a control character' }
        if ($a -match $BlockedArgs) { throw "argument $a is not allowed through the bridge" }
        $list += $a
    }
    $key2 = if ($list.Count -ge 2) { "$($list[0]) $($list[1])" } else { $null }
    $kind = $null
    if ($key2 -and $Allow.ContainsKey($key2)) { $kind = $Allow[$key2] }
    elseif ($Allow.ContainsKey($list[0])) { $kind = $Allow[$list[0]] }
    if (-not $kind) { throw "'$($list[0..([Math]::Min(1, $list.Count - 1))] -join ' ')' is not on the bridge allowlist" }
    if ($key2 -eq 'board phase' -and ($list.Count -lt 3 -or $BoardPhaseRead -notcontains $list[2])) { $kind = 'write' }
    if ($kind -eq 'write' -and -not $AllowWrites) { throw "'$key2' changes state; restart the bridge with -AllowWrites to allow it" }
    return @{ argv = @($AgentStudio) + $list; kind = $kind }
}

Write-Host "Agent Studio bridge for $Workspace"
Write-Host "  agent-studio: $AgentStudio  (WSL $(if ($Distro) { $Distro } else { 'default distro' }))"
Write-Host "  writes: $(if ($AllowWrites) { 'ALLOWED' } else { 'blocked (read-only)' })   Ctrl+C to stop"

$lastStatus = [DateTime]::MinValue
$lastPrune = [DateTime]::MinValue
try {
    while ($true) {
        if (((Get-Date) - $lastStatus).TotalSeconds -ge 3) { Write-Status; $lastStatus = Get-Date }
        if (((Get-Date) - $lastPrune).TotalMinutes -ge 30) {
            Get-ChildItem -LiteralPath $ResDir -Filter '*.json' -File |
                Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue
            $lastPrune = Get-Date
        }
        $files = Get-ChildItem -LiteralPath $ReqDir -Filter '*.json' -File | Where-Object { $_.Name -notlike '.*' } | Sort-Object Name
        foreach ($f in $files) {
            $id = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
            $resp = [ordered]@{ id = $id; ok = $false; receivedAt = (Get-Date).ToUniversalTime().ToString('o') }
            try {
                if ($id -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'request file name must be <id>.json with id [A-Za-z0-9_-]{1,64}' }
                $req = [System.IO.File]::ReadAllText($f.FullName, $Utf8) | ConvertFrom-Json
                $r = Resolve-Request $req
                $resp.kind = $r.kind
                $resp.args = @($r.argv | Select-Object -Skip 1)
                Write-Host "$(Get-Date -Format HH:mm:ss) $id [$($r.kind)] $(($r.argv | Select-Object -Skip 1) -join ' ')"
                $run = Invoke-Wsl $r.argv $TimeoutSec
                foreach ($k in $run.Keys) { $resp[$k] = $run[$k] }
                $resp.ok = (-not $run.timedOut) -and $run.exitCode -eq 0
            }
            catch {
                $resp.error = $_.Exception.Message
                Write-Host "$(Get-Date -Format HH:mm:ss) $id refused: $($resp.error)"
            }
            $resp.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
            Write-JsonFile (Join-Path $ResDir "$id.json") $resp
            Add-Content -LiteralPath (Join-Path $Bridge 'audit.txt') -Encoding UTF8 -Value (
                "$($resp.finishedAt) $id ok=$($resp.ok) " + $(if ($resp.Contains('args')) { ($resp.args -join ' ') } else { "error=$($resp.error)" }))
            Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds $PollMs
    }
}
finally {
    if ($lock) { $lock.Dispose() }
    Write-Host 'bridge stopped'
}
