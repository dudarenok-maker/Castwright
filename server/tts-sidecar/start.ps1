# Start the TTS sidecar using the venv's python directly. No `Activate.ps1`
# dot-sourcing — that requires a permissive PowerShell execution policy
# (RemoteSigned/Bypass) and is the most common setup snag on Windows.
# Calling .venv\Scripts\python.exe works under the default Restricted policy.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$venvPython = Join-Path $here ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Error @"
Local TTS sidecar venv not found at $venvPython.
Run the one-time setup first (see server\tts-sidecar\README.md):

  cd server\tts-sidecar
  python -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -r requirements.txt
"@
    exit 1
}

$port = if ($env:LOCAL_TTS_PORT) { $env:LOCAL_TTS_PORT } else { "9000" }
$bindHost = if ($env:LOCAL_TTS_HOST) { $env:LOCAL_TTS_HOST } else { "127.0.0.1" }

# Pre-accept the Coqui Public Model License so the TTS library doesn't try to
# prompt via input() during the first model download — which raises EOFError
# the moment we run hidden / non-interactive (the start-app.bat path). The
# project is local/personal-use only; see the license note in main.py:15-18.
if (-not $env:COQUI_TOS_AGREED) { $env:COQUI_TOS_AGREED = "1" }

Push-Location $here
try {
    & $venvPython -m uvicorn main:app --host $bindHost --port $port
} finally {
    Pop-Location
}
