#requires -Version 5.1
# Start the audiobook app: frontend (Vite :5173), server (Express :8080),
# and TTS sidecar (uvicorn :9000) — all backgrounded, logs in logs\*.log,
# PIDs tracked in .run\*.pid. Idempotent: re-running while alive just
# re-opens the browser.

$ErrorActionPreference = "Stop"

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
foreach ($svc in $toStart) {
    $outLog = Join-Path $logDir "$($svc.Name).log"
    $errLog = Join-Path $logDir "$($svc.Name).err.log"
    # Truncate previous logs so tails are meaningful for *this* run.
    Set-Content -Path $outLog -Value "" -Encoding utf8
    Set-Content -Path $errLog -Value "" -Encoding utf8

    $proc = Start-Process -FilePath $svc.FilePath `
        -ArgumentList $svc.ArgList `
        -WorkingDirectory $svc.WorkDir `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError  $errLog `
        -WindowStyle Hidden `
        -PassThru

    $proc.Id | Out-File -FilePath (Join-Path $runDir "$($svc.Name).pid") -Encoding ascii
    Write-Status "[START] $($svc.Name) pid=$($proc.Id) -> logs\$($svc.Name).log"
}

# --- Health-wait: poll until each port is listening. Test-PortListening
# (defined above) reads the kernel TCP socket table, so it works regardless
# of whether the service binds to 127.0.0.1, ::1, or both — Vite 5 binds
# to ::1 only on Windows, which trips up address-specific TCP-connect probes.

# XTTS cold-start on first run can take ~60-120s (model load). Be generous.
$timeoutSec = 240
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
        $errLog = Join-Path $logDir "$name.err.log"
        $tail   = if (Test-Path $errLog) {
            (Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n"
        } else { "(no err log)" }
        "--- $name (port not listening) ---`n$tail`n"
    }
    Fail ("Services did not come up within $timeoutSec s: $($pending -join ', ')`n`n" + ($detail -join "`n"))
}

# --- Open browser --------------------------------------------------------
Start-Process "http://localhost:5173/"
Write-Status "[READY] http://localhost:5173/ (stop with stop-app.bat)"
exit 0
