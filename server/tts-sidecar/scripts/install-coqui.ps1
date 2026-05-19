# install-coqui.ps1 -- pre-fetch the Coqui XTTS v2 model weights so the
# sidecar doesn't pay the ~2 GB download tax on the first synth call.
#
# Plan 61: parallel to install-kokoro.ps1, ships in the release bundle
# so a Windows deployer who wants XTTS doesn't have to drop to a terminal.
#
# Strategy mirrors install-coqui.sh exactly:
#   - locate the sidecar venv's python.exe
#   - point TTS_HOME at server/tts-sidecar/voices/coqui/
#   - invoke `python -c "from TTS.api import TTS; TTS('xtts_v2')"` to
#     trigger the lib's auto-downloader into TTS_HOME
#   - skip if XTTS-v2 manifest dir is already present
#
# ASCII-only per repo convention (Windows PowerShell 5.1 reads UTF-8
# without BOM as Win-1252 and mojibakes em-dashes/smart-quotes).

[CmdletBinding()]
param(
    [string]$TargetDir = ''
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) {
    Write-Host "[install-coqui] $msg"
}

# Resolve script + sidecar dirs at runtime.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) {
    $ScriptDir = (Get-Location).Path
}
$SidecarDir = (Resolve-Path -LiteralPath (Join-Path $ScriptDir '..')).Path

if (-not $TargetDir) {
    $TargetDir = Join-Path $SidecarDir 'voices\coqui'
}

# Locate python in the sidecar venv. Two layouts to try:
$Python = $null
$candidates = @(
    (Join-Path $SidecarDir '.venv\Scripts\python.exe'),
    (Join-Path $SidecarDir '.venv\bin\python.exe'),
    (Join-Path $SidecarDir '.venv\bin\python')
)
foreach ($cand in $candidates) {
    if (Test-Path -LiteralPath $cand) {
        $Python = $cand
        break
    }
}

if (-not $Python) {
    Write-Step "FAIL: sidecar venv not bootstrapped at $SidecarDir\.venv."
    Write-Step "      Run 'python -m venv .venv; .venv\Scripts\pip install -r requirements.txt'"
    Write-Step "      from $SidecarDir first, then re-run this script."
    exit 1
}

if (-not (Test-Path -LiteralPath $TargetDir)) {
    Write-Step "Creating $TargetDir"
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

# Skip download when the manifest dir is already populated.
$XttsDir = Join-Path $TargetDir 'tts\tts_models--multilingual--multi-dataset--xtts_v2'
$ModelPath = Join-Path $XttsDir 'model.pth'
$ConfigPath = Join-Path $XttsDir 'config.json'

if ((Test-Path -LiteralPath $ModelPath) -and (Test-Path -LiteralPath $ConfigPath)) {
    Write-Step "Skipping -- XTTS v2 weights already present at $XttsDir"
    exit 0
}

Write-Step "Pre-fetching XTTS v2 into $TargetDir via the TTS lib (~1.8 GB, expect 2-5 min on a fast link)..."

# Force a Python that uses our TTS_HOME and silently agrees to the
# license click-through (script invocation is the consent).
$env:TTS_HOME = $TargetDir
$env:COQUI_TOS_AGREED = '1'

# Use TLS 1.2 for any pip-style fallback. The TTS lib uses requests under
# the hood, which honours the system trust store.
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

$pyArgs = @('-c', "from TTS.api import TTS; TTS('tts_models/multilingual/multi-dataset/xtts_v2')")
& $Python @pyArgs
if ($LASTEXITCODE -ne 0) {
    Write-Step "FAIL: XTTS v2 pre-fetch failed. Check network + sidecar venv."
    exit 1
}

if (-not (Test-Path -LiteralPath $ModelPath)) {
    Write-Step "FAIL: model.pth not at $XttsDir after fetch. Lib changed path?"
    exit 1
}

$size = (Get-Item -LiteralPath $ModelPath).Length
$mb = [math]::Round($size / 1MB, 1)
Write-Step "Done. XTTS v2 weights at $XttsDir (model.pth $mb MB)."
Write-Step "Restart the sidecar with PRELOAD_COQUI=1 to eagerly load on boot,"
Write-Step "or leave defaults to load XTTS lazily on first synth call."
