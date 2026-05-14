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
#
# Default for PRELOAD_COQUI is now 0 (lazy load). Set PRELOAD_COQUI=1 in
# server/.env to restore the old eager-load-on-startup behaviour; the
# in-app Load button on the Generate / Analysing screen triggers the
# lazy path on demand.
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

# If DeepSpeed is on, the first synth call lazy-compiles the transformer_inference
# CUDA op via ninja → nvcc → cl.exe. The user's interactive shell may not have
# the CUDA Toolkit or MSVC toolchain on PATH, so the compile would fail and
# DeepSpeed would silently fall back to vanilla mode (sidecar still works, just
# at ~2-3× slower RTF). Source vcvars64.bat once at startup so MSVC + Windows SDK
# are reachable; export CUDA_HOME so DeepSpeed's op_builder finds nvcc.
#
# Skip silently if either is absent — keeps the script working for users who
# never installed the DeepSpeed prereqs (the wider CUDA + fp16 path is unaffected,
# and the sidecar's try/except around init_gpt_for_inference catches any failure).
$deepspeedRequested = $env:COQUI_DEEPSPEED -in @('1','true','yes','on','True','TRUE')
if ($deepspeedRequested) {
    # Pick the highest CUDA Toolkit installed (we currently expect v12.4 to match
    # the cu124 torch wheel; a future upgrade just bumps this number).
    $cudaRoot = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"
    if (Test-Path $cudaRoot) {
        $cudaVer = Get-ChildItem $cudaRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($cudaVer) {
            $env:CUDA_PATH = $cudaVer.FullName
            $env:CUDA_HOME = $cudaVer.FullName
            if ($env:PATH -notlike "*$($cudaVer.FullName)\bin*") {
                $env:PATH = "$($cudaVer.FullName)\bin;$($cudaVer.FullName)\libnvvp;$env:PATH"
            }
        }
    }
    $vcvars = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    if ((Test-Path $vcvars) -and -not $env:VSINSTALLDIR) {
        # vcvars64.bat is cmd-only; capture its env and replay into PowerShell.
        # `>nul 2>&1` keeps the banner out of our log; `&& set` dumps the resulting
        # env so we can re-export the deltas.
        cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
            if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
        }
        # vcvars stomps CUDA_HOME — re-export from CUDA_PATH which it leaves alone.
        if ($env:CUDA_PATH) { $env:CUDA_HOME = $env:CUDA_PATH }
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
