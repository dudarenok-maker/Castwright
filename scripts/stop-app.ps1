#requires -Version 5.1
# Stop everything started by start-app.ps1. Reads .run\*.pid, kills the
# whole process tree (taskkill /T — npm.cmd shims spawn node children),
# then sweeps any orphaned listeners on the three known ports.

$ErrorActionPreference = "Continue"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

Import-Module (Join-Path $PSScriptRoot "lib\log-utils.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "lib\sidecar-sweep-port.psm1") -Force

# Mirror server/src/app-dirs.ts's resolveRunDir(): honour APP_RUN_DIR (the
# versioned-install layout, fs-1) so this sweep looks in the SAME .run\ the
# server actually wrote its owner note to, rather than always
# <repoRoot>\.run (#2632 N29). Resolve-RunDir (log-utils.psm1) is a lexical
# resolve, not a filesystem lookup — see its own comment (#2632 N35): the
# non-existent-path case is exactly the routine one this script must not
# silently no-op on. start-app.ps1 uses the SAME helper so the two agree.
$runDir = Resolve-RunDir -RepoRoot $repoRoot -AppRunDir $env:APP_RUN_DIR
$serverEnvPath = Join-Path $repoRoot "server\.env"

function Write-Status($msg) { try { Write-Host $msg } catch {} }

$names = @("frontend", "server", "tts")
$killedAny = $false

foreach ($name in $names) {
    $pidPath = Join-Path $runDir "$name.pid"
    if (-not (Test-Path $pidPath)) { continue }
    $raw = (Get-Content $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
    $procId = 0
    if (-not [int]::TryParse($raw, [ref]$procId)) { continue }
    # /T = tree, /F = force. Suppress output; we'll report ourselves.
    & taskkill /PID $procId /T /F *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Status "[STOP] $name pid=$procId"
        $killedAny = $true
    } else {
        Write-Status "[GONE] $name pid=$procId (already exited)"
    }
}

# Belt-and-braces: kill any orphaned listeners on our ports. :8443 is the LAN
# HTTPS port (LAN_HTTPS=1 in server/.env or npm run dev:lan) — sweep it too.
# The TTS port is per-checkout since #2632 (LOCAL_TTS_PORT); Get-PortsToSweep
# reads the ACTUAL owned port from .run\tts.owner.json when a sidecar has
# claimed one, falling back to what this checkout's own server\.env / shell
# environment CONFIGURE LOCAL_TTS_PORT to (not necessarily the port a
# sidecar is actually bound to right now) — never assuming 9000, which would
# force-kill a DIFFERENT checkout's sidecar from a worktree (#2632 N27/N29).
# When neither source yields a port, skip sweeping the TTS port entirely
# rather than guessing 9000.
$ports = Get-PortsToSweep -BasePorts @(5173, 8080, 8443) -RunDir $runDir -ServerEnvPath $serverEnvPath
$conns = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    foreach ($c in $conns) {
        try {
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
            Write-Status "[SWEEP] killed pid=$($c.OwningProcess) on :$($c.LocalPort)"
            $killedAny = $true
        } catch {
            Write-Status "[SWEEP] could not kill pid=$($c.OwningProcess) on :$($c.LocalPort): $($_.Exception.Message)"
        }
    }
}

if (-not $killedAny) { Write-Status "[OK] nothing to stop" }
exit 0
