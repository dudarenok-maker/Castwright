#requires -Version 5.1
# Start the audiobook app: frontend (Vite :5173), server (Express :8080),
# and TTS sidecar (uvicorn :9000) — all backgrounded, logs in logs\*.log,
# PIDs tracked in .run\*.pid. Idempotent: re-running while alive just
# re-opens the browser.

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

# --- Service definitions --------------------------------------------------
$services = @(
    @{
        Name      = "frontend"
        Port      = 5173
        FilePath  = "npm.cmd"
        ArgList   = @("run", "dev:frontend")
        WorkDir   = $repoRoot
    },
    @{
        Name      = "server"
        Port      = 8080
        FilePath  = "npm.cmd"
        ArgList   = @("run", "dev:server")
        WorkDir   = $repoRoot
    },
    @{
        Name      = "tts"
        Port      = 9000
        FilePath  = "powershell.exe"
        ArgList   = @("-ExecutionPolicy", "Bypass", "-NoProfile", "-File",
                      (Join-Path $repoRoot "server\tts-sidecar\start.ps1"))
        WorkDir   = $repoRoot
    }
)

# --- Preflight: TTS venv must exist before we spawn anything --------------
$venvPython = Join-Path $repoRoot "server\tts-sidecar\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Fail @"
TTS sidecar venv not found at: $venvPython

One-time setup (see server\tts-sidecar\README.md):
  cd server\tts-sidecar
  python -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -r requirements.txt
"@
}

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

# Port-readiness no longer includes the XTTS model load. The sidecar now
# defaults PRELOAD_COQUI=0 (see server/tts-sidecar/main.py) — uvicorn
# binds :9000 in ~2s with the model unloaded, and the in-app Load button
# warms XTTS on demand. 60s is generous for fresh npm install + tsx
# warm-up; anyone who flips PRELOAD_COQUI=1 should bump this back up.
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
Write-Status "[READY] http://localhost:5173/ (stop with stop-app.bat)"

# Best-effort cleanup of stale rotated logs from past locked-start cycles.
# Canonical `<name>.log` / `<name>.err.log` are preserved; only timestamped
# siblings older than 7 days are pruned.
Remove-OldRotatedLogs -Dir $logDir -MaxAgeDays 7

exit 0
