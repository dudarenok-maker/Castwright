#requires -Version 5.1
# Stop everything started by start-app.ps1. Reads .run\*.pid, kills the
# whole process tree (taskkill /T — npm.cmd shims spawn node children),
# then sweeps any orphaned listeners on this checkout's own configured
# ports (#2632 N39; never a different checkout's).

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
$envLocalPath = Join-Path $repoRoot ".env.local"

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

# The TTS port is per-checkout since #2632 (LOCAL_TTS_PORT); Get-PortsToSweep
# reads the ACTUAL owned port from .run\tts.owner.json when a sidecar has
# claimed one, falling back to what this checkout's own server\.env / shell
# environment CONFIGURE LOCAL_TTS_PORT to (not necessarily the port a
# sidecar is actually bound to right now) — never assuming 9000, which would
# force-kill a DIFFERENT checkout's sidecar from a worktree (#2632 N27/N29).
# When neither source yields a port, skip sweeping the TTS port entirely
# rather than guessing 9000.
#
# #2632 N39 — the frontend/server base ports need the SAME per-checkout
# discipline: :5173/:8080 are only safe to sweep for the checkout actually
# configured for them. Get-ConfiguredVitePort/-ServerPort read this
# checkout's own .env.local/server\.env (wt-new.mjs writes both per
# worktree); when either is unconfigured (a hand-edited primary checkout),
# it drops OUT of the sweep list entirely rather than falling back to the
# primary's :5173/:8080 — those two literals used to force-kill the primary
# checkout's Vite and server from any worktree running `npm run dev`.
#
# :8443 (LAN HTTPS) is deliberately NOT swept, for the same reason and one
# more on top of it. It used to be a blind literal — the exact hazard this
# fix exists to close, since wt-new.mjs never offsets it per worktree. Unlike
# PORT/VITE_PORT, config alone can't establish ownership of it even when
# THIS checkout's own server\.env sets LAN_HTTPS=1: dev mode never rebinds
# (autoRebind is NODE_ENV=production-gated, index.ts:430, and dev never sets
# that), so if a rebind-free process is genuinely listening on :8443 when a
# SECOND checkout also configured for LAN_HTTPS never got that far — dev mode
# exits with an actionable EADDRINUSE message instead of silently rebinding
# (crash-logging.ts) — "my config says LAN_HTTPS=1" does not mean "the
# process holding :8443 right now is mine"; it only means I would have been
# the one holding it had I won the race. There's no owner-note file for the
# main server's bound port the way .run\tts.owner.json exists for the
# sidecar, so there is no authoritative source here at all — only the PID
# the taskkill loop above already reaped when start-app.ps1 wrote it.
# Killing nothing is safer than guessing whose :8443 it is.
$vitePort = Get-ConfiguredVitePort -EnvLocalPath $envLocalPath
$serverPort = Get-ConfiguredServerPort -ServerEnvPath $serverEnvPath
$basePorts = @()
if ($serverPort) { $basePorts = @($serverPort) + $basePorts }
if ($vitePort) { $basePorts = @($vitePort) + $basePorts }
$ports = Get-PortsToSweep -BasePorts $basePorts -RunDir $runDir -ServerEnvPath $serverEnvPath
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
