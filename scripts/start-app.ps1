#requires -Version 5.1
# Start the audiobook app: frontend (Vite :5173) and server (Express :8080)
# — both backgrounded, logs in logs\*.log, PIDs tracked in .run\*.pid.
# Idempotent: re-running while alive just re-opens the browser.
#
# Plan 43: the TTS sidecar (uvicorn :9000) is no longer launched from here.
# The Node server spawns it as a child process at app.listen time, gated
# on the user's `autoStartSidecar` preference (default true). Its PID
# still lands in .run\tts.pid so stop-app.ps1 reaps it the same way.

$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "lib\log-utils.psm1") -Force

# --- Layout ---------------------------------------------------------------
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
$runDir  = Join-Path $repoRoot ".run"
$logDir  = Join-Path $repoRoot "logs"
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$failMarker = Join-Path $logDir "start-failed.txt"
if (Test-Path $failMarker) { Remove-Item $failMarker -Force }

function Write-Status($msg) {
    # Host-safe: only write if a real console is attached.
    try { Write-Host $msg } catch {}
}

function Fail($msg) {
    $msg | Out-File -FilePath $failMarker -Encoding utf8 -Append
    Write-Status "[FAIL] $msg"
    exit 1
}

# --- LAN mode (companion app, plan 188) -----------------------------------
# server/.env LAN_HTTPS=1 makes the Node server bind HTTPS on :8443 / 0.0.0.0
# (see server/src/index.ts + bind-host.ts). Mirror that here so `npm start`
# brings up the matching LAN dev stack instead of false-failing the health-wait
# on :8080: the server moves to :8443 and Vite runs HTTPS (vite-plugin-mkcert)
# bound to all interfaces — exactly what `npm run dev:lan` does explicitly. The
# proxy target follows in vite.config.ts (https://localhost:8443 when LAN).
$serverEnvPath = Join-Path $repoRoot "server\.env"
$lanHttps = $false
if (Test-Path $serverEnvPath) {
    if (Select-String -Path $serverEnvPath -Pattern '^\s*LAN_HTTPS\s*=\s*1\s*$' -Quiet) {
        $lanHttps = $true
    }
}
$serverPort = if ($lanHttps) { 8443 } else { 8080 }
$frontendArgs = if ($lanHttps) { @("run", "dev:frontend", "--", "--host", "0.0.0.0") } else { @("run", "dev:frontend") }
if ($lanHttps) {
    # Read by vite.config.ts (useHttps) — inherited by the Start-Process children.
    $env:VITE_HTTPS = "1"
    Write-Status "[LAN] LAN_HTTPS=1 in server/.env — LAN dev stack: server HTTPS :8443, Vite HTTPS all-interface :5173"
}

# --- Service definitions --------------------------------------------------
$services = @(
    @{
        Name      = "frontend"
        Port      = 5173
        FilePath  = "npm.cmd"
        ArgList   = $frontendArgs
        WorkDir   = $repoRoot
    },
    @{
        Name      = "server"
        Port      = $serverPort
        FilePath  = "npm.cmd"
        ArgList   = @("run", "dev:server")
        WorkDir   = $repoRoot
    }
)

# Plan 43: the TTS venv preflight used to live here. It's been removed
# because Node now owns the sidecar spawn — when the user's
# `autoStartSidecar` preference is off, a missing venv is irrelevant;
# when it's on, Node's child process exits non-zero and the failure
# surfaces via /api/sidecar/health and logs/tts.err.log. Hard-failing
# the whole stack here would punish users who deliberately disabled
# auto-start.

# --- Preflight: ffmpeg required for chapter-audio MP3 encoding ------------
# generation.ts pipes PCM through `ffmpeg -c:a libmp3lame -q:a 2` at chapter
# boundaries. Without it, every chapter generation rejects at the encode
# step. Fail fast at start-up with an actionable install hint rather than
# surfacing as a cryptic ffmpeg-spawn ENOENT mid-stream.
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Fail @"
ffmpeg not found on PATH.

The server encodes chapter audio to MP3 (LAME VBR V2) via the system
ffmpeg binary. Install it once and restart this shell:

  winget install Gyan.FFmpeg

(Then close + reopen PowerShell so the updated PATH is picked up.)
"@
}

# --- Idempotency: a service is "alive" iff something is listening on its
# port. PIDs are unreliable: npm.cmd is a shim that exits after spawning
# node, so the recorded parent PID dies seconds after launch even though
# the real Vite/tsx node child keeps listening.
function Test-PortListening($port) {
    $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

$toStart = @()
foreach ($svc in $services) {
    $pidPath = Join-Path $runDir "$($svc.Name).pid"
    if (Test-PortListening $svc.Port) {
        Write-Status "[SKIP] $($svc.Name) already listening on :$($svc.Port)"
    } else {
        if (Test-Path $pidPath) { Remove-Item $pidPath -Force }
        $toStart += $svc
    }
}

# --- Spawn missing services ----------------------------------------------
# Track actual log paths per service — New-FreshLog may rotate to a
# timestamped sibling when OneDrive/AV still hold the canonical name open,
# and the failure-tail block below needs to read the path we actually used.
$logPaths = @{}
foreach ($svc in $toStart) {
    $outRequested = Join-Path $logDir "$($svc.Name).log"
    $errRequested = Join-Path $logDir "$($svc.Name).err.log"
    $outLog = New-FreshLog -Path $outRequested
    $errLog = New-FreshLog -Path $errRequested
    if ($outLog -ne $outRequested) {
        Write-Status "[ROTATE] $(Split-Path -Leaf $outRequested) locked; writing to $(Split-Path -Leaf $outLog)"
    }
    if ($errLog -ne $errRequested) {
        Write-Status "[ROTATE] $(Split-Path -Leaf $errRequested) locked; writing to $(Split-Path -Leaf $errLog)"
    }
    $logPaths[$svc.Name] = @{ Out = $outLog; Err = $errLog }

    $proc = Start-Process -FilePath $svc.FilePath `
        -ArgumentList $svc.ArgList `
        -WorkingDirectory $svc.WorkDir `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError  $errLog `
        -WindowStyle Hidden `
        -PassThru

    $proc.Id | Out-File -FilePath (Join-Path $runDir "$($svc.Name).pid") -Encoding ascii
    $logName = Split-Path -Leaf $outLog
    Write-Status "[START] $($svc.Name) pid=$($proc.Id) -> logs\$logName"
}

# --- Health-wait: poll until each port is listening. Test-PortListening
# (defined above) reads the kernel TCP socket table, so it works regardless
# of whether the service binds to 127.0.0.1, ::1, or both. Vite is now
# pinned to 127.0.0.1 in vite.config.ts (host: '127.0.0.1') so Chrome's
# IPv4-first resolution of "localhost" connects immediately; the IPv6/IPv4
# probe-agnosticism here is belt-and-braces in case that ever changes.

# Port-readiness covers frontend (:5173) and server (:8080) only. The TTS
# sidecar (:9000) is now spawned by the Node server itself (plan 43), so
# its readiness is decoupled from this gate — /api/sidecar/health will
# show green once Node finishes warming Kokoro, which we don't block on.
# 60s is generous for fresh npm install + tsx warm-up.
$timeoutSec = 60
$deadline   = (Get-Date).AddSeconds($timeoutSec)
$pending    = @($services | ForEach-Object { $_.Name })
$ready      = @{}

while ($pending.Count -gt 0 -and (Get-Date) -lt $deadline) {
    foreach ($name in @($pending)) {
        $svc = $services | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        if (Test-PortListening $svc.Port) {
            $ready[$name] = $true
            $pending = @($pending | Where-Object { $_ -ne $name })
            Write-Status "[OK] $name on :$($svc.Port)"
        }
    }
    if ($pending.Count -gt 0) { Start-Sleep -Milliseconds 750 }
}

if ($pending.Count -gt 0) {
    $detail = foreach ($name in $pending) {
        $errLog = if ($logPaths.ContainsKey($name)) {
            $logPaths[$name].Err
        } else {
            Join-Path $logDir "$name.err.log"
        }
        $tail   = if (Test-Path $errLog) {
            (Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
        } else { "(no err log)" }
        "--- $name (port not listening) ---`n$tail`n"
    }
    Fail ("Services did not come up within $timeoutSec s: $($pending -join ', ')`n`n" + ($detail -join "`n"))
}

# --- Browser opens itself ------------------------------------------------
# Vite's `server.open = true` (vite.config.ts) launches the default browser
# at http://localhost:5173/ the moment dev:frontend is listening. We used to
# *also* call Start-Process URL here, which surfaced as two Chrome tabs on
# every start. The script-side launcher is gone; Vite is the single opener.
$readyProto = if ($lanHttps) { "https" } else { "http" }
Write-Status "[READY] ${readyProto}://localhost:5173/ (stop with stop-app.bat)"

# Best-effort cleanup of stale rotated logs from past locked-start cycles.
# Canonical `<name>.log` / `<name>.err.log` are preserved; only timestamped
# siblings older than 7 days are pruned.
Remove-OldRotatedLogs -Dir $logDir -MaxAgeDays 7

exit 0
