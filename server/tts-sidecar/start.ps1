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

# Source the relevant sidecar knobs out of server/.env so users can configure
# COQUI_DEVICE / COQUI_HALF / COQUI_DEEPSPEED / PRELOAD_COQUI in one place
# instead of remembering to export them in every shell they launch the
# sidecar from. We deliberately whitelist a prefix list rather than slurp
# everything — `server/.env` also carries GEMINI_API_KEY and unrelated
# server config that the sidecar has no business inheriting.
$envFile = Join-Path (Split-Path -Parent $here) ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $eq = $line.IndexOf("=")
        if ($eq -lt 1) { return }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
        # Whitelist: only forward sidecar-relevant keys. Keeps Gemini keys
        # and unrelated server config out of the sidecar process env.
        if ($key -match '^(COQUI_|PRELOAD_COQUI|LOCAL_TTS_)') {
            # Don't overwrite an existing shell export — explicit shell env
            # wins over file config, matching the convention of every other
            # dotenv reader (Node's loadEnvFile included).
            if (-not (Get-Item -Path "env:$key" -ErrorAction SilentlyContinue)) {
                Set-Item -Path "env:$key" -Value $value
            }
        }
    }
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
