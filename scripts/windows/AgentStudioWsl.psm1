# Agent Studio - Windows side of the WSL boundary (P00-S01).
# Rules enforced here (see phases/phase-00/architecture.md section B):
#   * Windows only runs: wsl.exe -d <distro> --exec <absolute entry path> <literal subcommand>
#   * Only fixed literals go on the command line; every request travels as UTF-8 JSON over stdin.
#   * Bytes are written to/read from the raw streams so no console code page can alter them.
# Compatible with Windows PowerShell 5.1 and PowerShell 7+. This file is ASCII-only on purpose.

Set-StrictMode -Version 2
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:SafeArg = '^[A-Za-z0-9._/:@+=~-]+$'
$script:Protocol = 'agent-studio/v1'

function Assert-SafeArg([string]$Value) {
    if ($Value -notmatch $script:SafeArg) {
        throw "Refusing to put '$Value' on the wsl.exe command line; only fixed literals are allowed there."
    }
}

function New-WslProcess([string]$Distro, [string[]]$Argv) {
    Assert-SafeArg $Distro
    foreach ($a in $Argv) { Assert-SafeArg $a }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl.exe'
    $psi.Arguments = ((@('-d', $Distro) + $Argv) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $script:Utf8
    $psi.StandardErrorEncoding = $script:Utf8
    return [System.Diagnostics.Process]::Start($psi)
}

function Invoke-WslRaw([string]$Distro, [string[]]$Argv, [byte[]]$StdinBytes = $null, [int]$TimeoutMs = 60000) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $p = New-WslProcess $Distro $Argv
    $errTask = $p.StandardError.ReadToEndAsync()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $in = $p.StandardInput.BaseStream
    if ($StdinBytes) { $in.Write($StdinBytes, 0, $StdinBytes.Length); $in.Flush() }
    $in.Close()
    if (-not $p.WaitForExit($TimeoutMs)) {
        try { $p.Kill() } catch { }
        throw "wsl.exe $($Argv -join ' ') timed out after $TimeoutMs ms"
    }
    $p.WaitForExit()
    [pscustomobject]@{ ExitCode = $p.ExitCode; Stdout = $outTask.Result; Stderr = $errTask.Result
                       ElapsedMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1) }
}

function Get-WslText([string]$Text) {
    # wsl.exe's own messages (unknown distro, WSL not installed, ...) are UTF-16; read as UTF-8 they carry NULs.
    if ($null -eq $Text) { return '' }
    return ($Text -replace "`0", '').Trim()
}

function Format-WslFailure($Raw) {
    $out = Get-WslText $Raw.Stdout
    $err = Get-WslText $Raw.Stderr
    return "exit code $($Raw.ExitCode); wsl output: '$out'; stderr: '$err'"
}

function ConvertFrom-AgentStudioOutput($Raw, [string]$What) {
    $lines = @($Raw.Stdout -split "`n" | Where-Object { $_.Trim() })
    if ($lines.Count -eq 0 -or -not $lines[-1].Trim().StartsWith('{')) {
        throw "No JSON response from $What ($(Format-WslFailure $Raw))."
    }
    return ($lines[-1] | ConvertFrom-Json)
}

function Assert-DistroExists([string]$Distro) {
    $r = Invoke-WslRaw -Distro $Distro -Argv @('--exec', '/bin/true')
    if ($r.ExitCode -ne 0) {
        throw ("WSL could not run anything in distro '$Distro' ($(Format-WslFailure $r)). " +
               "Check the exact name with: wsl -l -v")
    }
}

function Resolve-AgentStudioEntry([string]$Distro, [string]$EntryPath) {
    Assert-DistroExists $Distro
    if ($EntryPath) {
        Assert-SafeArg $EntryPath
        $path = $EntryPath
    } else {
        # Ask for HOME; if --exec does not provide it, let wsl.exe resolve ~ itself and print the directory.
        $wslHome = Get-WslText (Invoke-WslRaw -Distro $Distro -Argv @('--exec', '/usr/bin/printenv', 'HOME')).Stdout
        if (-not $wslHome.StartsWith('/')) {
            $r = Invoke-WslRaw -Distro $Distro -Argv @('--cd', '~', '--exec', '/bin/pwd')
            $wslHome = Get-WslText $r.Stdout
            if (-not $wslHome.StartsWith('/')) {
                throw "Could not find your home folder in distro '$Distro' ($(Format-WslFailure $r)). Pass -EntryPath /home/<you>/.local/bin/agent-studio"
            }
        }
        $path = "$wslHome/.local/bin/agent-studio"
        Assert-SafeArg $path
    }
    $t = Invoke-WslRaw -Distro $Distro -Argv @('--exec', '/usr/bin/test', '-x', $path)
    if ($t.ExitCode -ne 0) {
        throw "agent-studio is not installed at $path in '$Distro'. Inside WSL run: bash /mnt/c/Works/Projects/AgentStudio/backend/install.sh"
    }
    return $path
}

function Invoke-AgentStudio([string]$Distro, [string]$Entry, [string[]]$Subcommand) {
    $raw = Invoke-WslRaw -Distro $Distro -Argv (@('--exec', $Entry) + $Subcommand)
    [pscustomobject]@{ Response = (ConvertFrom-AgentStudioOutput $raw "agent-studio $($Subcommand -join ' ')")
                       ElapsedMs = $raw.ElapsedMs; Raw = $raw }
}

function ConvertTo-RequestBytes([hashtable]$Request) {
    if (-not $Request.ContainsKey('protocol')) { $Request['protocol'] = $script:Protocol }
    $json = $Request | ConvertTo-Json -Compress -Depth 10
    return $script:Utf8.GetBytes($json + "`n")
}

function Invoke-AgentStudioRequest([string]$Distro, [string]$Entry, [hashtable]$Request) {
    $raw = Invoke-WslRaw -Distro $Distro -Argv @('--exec', $Entry, 'request') -StdinBytes (ConvertTo-RequestBytes $Request)
    [pscustomobject]@{ Response = (ConvertFrom-AgentStudioOutput $raw 'agent-studio request'); ElapsedMs = $raw.ElapsedMs }
}

function Start-AgentStudioServe([string]$Distro, [string]$Entry) {
    $p = New-WslProcess $Distro @('--exec', $Entry, 'serve')
    [pscustomobject]@{ Process = $p; Stdin = $p.StandardInput.BaseStream; ErrTask = $p.StandardError.ReadToEndAsync() }
}

function Read-ServeLine($Session, [int]$TimeoutMs) {
    $task = $Session.Process.StandardOutput.ReadLineAsync()
    if (-not $task.Wait($TimeoutMs)) { throw "serve did not answer within $TimeoutMs ms" }
    if ($null -eq $task.Result) { throw "serve closed its output. stderr: $($Session.ErrTask.Result)" }
    return $task.Result
}

function Send-ServeBytes($Session, [byte[]]$Bytes, [int]$TimeoutMs = 30000) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $Session.Stdin.Write($Bytes, 0, $Bytes.Length)
    $Session.Stdin.Flush()
    $line = Read-ServeLine $Session $TimeoutMs
    [pscustomobject]@{ Response = ($line | ConvertFrom-Json); Line = $line
                       ElapsedMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 2) }
}

function Send-ServeRequest($Session, [hashtable]$Request, [int]$TimeoutMs = 30000) {
    Send-ServeBytes $Session (ConvertTo-RequestBytes $Request) $TimeoutMs
}

function Stop-AgentStudioServe($Session) {
    try { $Session.Stdin.Close() } catch { }
    if (-not $Session.Process.WaitForExit(10000)) { try { $Session.Process.Kill() } catch { } }
}

function Get-Sha256Hex([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash($script:Utf8.GetBytes($Text))
    return (-join ($hash | ForEach-Object { $_.ToString('x2') }))
}

function New-IdempotencyKey([string]$Prefix = 'win') { return "$Prefix-" + [guid]::NewGuid().ToString('N') }

function Get-Percentile([double[]]$Values, [double]$P) {
    if (-not $Values -or $Values.Count -eq 0) { return $null }
    $sorted = $Values | Sort-Object
    $idx = [math]::Min($sorted.Count - 1, [math]::Max(0, [int][math]::Ceiling($P * $sorted.Count) - 1))
    return [math]::Round($sorted[$idx], 2)
}

function Get-HostileStrings {
    $emoji = [char]::ConvertFromUtf32(0x1F600) + [char]::ConvertFromUtf32(0x1F680) + [char]::ConvertFromUtf32(0x1F9EA)
    $cjk = -join ([char[]](0x6F22, 0x5B57, 0x304B, 0x306A, 0x30AB, 0x30CA, 0xD55C, 0xAD6D, 0xC5B4))
    $accents = -join ([char[]](0x00FC, 0x006E, 0x00EF, 0x0063, 0x00F6, 0x0064, 0x00E9, 0x2014, 0x201C, 0x201D,
                                0x2018, 0x2019, 0x2026, 0x20AC, 0x20AB))
    $nl = "`n"; $crlf = "`r`n"; $tab = "`t"
    return @(
        "single 'quote' and double `"quote`" and `"`"empty`"`"",
        'dollar $HOME $(whoami) ${PATH} $env:USERPROFILE @args',
        'backtick `id` `$x `` and `n literal',
        'percent %PATH% %USERPROFILE% ^& ^| !delayed!',
        'shell ; rm -rf ~ && echo pwned || true | cat > /tmp/x < /etc/passwd 2>&1 &',
        "newline${nl}second line${crlf}third${tab}tab",
        "emoji $emoji and CJK $cjk",
        "accents $accents",
        'C:\Users\Some One\My Projects\agent studio\file.txt',
        '\\wsl$\Ubuntu\home\user\project',
        '{"protocol":"agent-studio/v1","command":"coordinator.stop"}',
        "all of it: '`"`$HOME``;&&|%PATH%${nl}$emoji$cjk C:\x y\z",
        ''
    )
}

Export-ModuleMember -Function *
