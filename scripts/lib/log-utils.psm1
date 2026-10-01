#requires -Version 5.1
# Shared log helpers for the start/stop scripts. Extracted into a module so
# Pester can exercise them without running the full startup sequence.

# Truncate a log so this run starts clean. If the file is locked — OneDrive
# holds recently-modified files open for cloud sync, AV scanners can do the
# same — rotate to a timestamped sibling and return that path instead so
# Start-Process redirection still succeeds.
function New-FreshLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )
    try {
        Set-Content -Path $Path -Value "" -Encoding utf8 -ErrorAction Stop
        return $Path
    } catch {
        $dir   = Split-Path -Parent $Path
        $base  = [System.IO.Path]::GetFileNameWithoutExtension($Path)
        $ext   = [System.IO.Path]::GetExtension($Path)
        $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
        $rotated = Join-Path $dir "$base.$stamp$ext"
        Set-Content -Path $rotated -Value "" -Encoding utf8
        return $rotated
    }
}

# Delete rotated `<name>.YYYYMMDD-HHMMSS.log` files older than MaxAgeDays.
# Canonical (untimestamped) logs like `tts.log` and `tts.err.log` are left
# alone regardless of age — only the timestamped siblings are pruned.
# Failures are swallowed: cleanup is best-effort and must not abort startup.
function Remove-OldRotatedLogs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Dir,
        [int]    $MaxAgeDays = 7
    )
    if (-not (Test-Path $Dir)) { return }
    $cutoff  = (Get-Date).AddDays(-$MaxAgeDays)
    $pattern = '\.\d{8}-\d{6}$'
    Get-ChildItem -Path $Dir -File -Filter "*.log" -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -match $pattern -and $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop }
            catch { }
        }
}

# Lexical run-dir resolution mirroring server/src/app-dirs.ts's
# resolveRunDir(): honour APP_RUN_DIR (fs-1's versioned-install layout) with
# a PURELY LEXICAL resolve — never touch the filesystem, never require the
# path to exist. `Resolve-Path` is the wrong tool here (#2632 N35): it's a
# filesystem lookup that returns $null (silently, under
# $ErrorActionPreference = "Continue") for a path that doesn't exist yet —
# e.g. a versioned install before its first launch, or autoStartSidecar off
# so nothing has mkdir'd .run/ yet — which collapses every downstream
# consumer to a binding error and makes stop-app.ps1 report "[OK] nothing to
# stop" while everything is still running. GetUnresolvedProviderPathFromPSPath
# resolves relative paths against the current location (set via
# Set-Location $RepoRoot below) exactly like Node's path.resolve() resolves
# against process.cwd() — same semantics, no filesystem round-trip.
function Resolve-RunDir {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $RepoRoot,
        [string] $AppRunDir
    )
    if ($AppRunDir) {
        return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($AppRunDir)
    }
    return Join-Path $RepoRoot ".run"
}

function Test-ProcessAlive {
    param([Parameter(Mandatory)][int]$ProcessId)
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# Kill one pid's process tree and classify the outcome by LIVENESS, never by
# taskkill's exit code (E104: `taskkill /T` exits nonzero — 128 on Windows —
# when a child had already exited mid-walk even though the whole tree IS gone;
# PR #3404 review pass 3). Mirrors scripts/stop-app.mjs's killTree: probe
# BEFORE the kill (so "already exited" is told apart from "we killed it"), then
# wait up to -GraceMs for the pid to actually exit.
#
# Returns 'gone' (dead before the call; no kill attempted), 'killed' (alive
# beforehand, confirmed dead now) or 'failed' (still alive after the grace).
# -KillAction is injectable purely for testing.
function Stop-ProcessTreeByLiveness {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [scriptblock]$KillAction = { param($p) & taskkill /PID $p /T /F *> $null },
        [int]$GraceMs = 5000,
        [int]$PollMs = 100
    )
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return 'gone' }
    try { & $KillAction $ProcessId } catch { }
    $deadline = [DateTime]::UtcNow.AddMilliseconds($GraceMs)
    while ($true) {
        if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return 'killed' }
        if ([DateTime]::UtcNow -ge $deadline) { return 'failed' }
        Start-Sleep -Milliseconds $PollMs
    }
}

Export-ModuleMember -Function New-FreshLog, Remove-OldRotatedLogs, Resolve-RunDir, Stop-ProcessTreeByLiveness
