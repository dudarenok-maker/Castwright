# Start the TTS sidecar using the venv's python directly. No `Activate.ps1`
# dot-sourcing — that requires a permissive PowerShell execution policy
# (RemoteSigned/Bypass) and is the most common setup snag on Windows.
# Calling .venv\Scripts\python.exe works under the default Restricted policy.

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# The venv defaults to .venv next to this script (the single-checkout layout),
# but SIDECAR_VENV_DIR overrides it so a versioned-dir install (fs-1) can share
# ONE multi-GB venv across releases instead of rebuilding it inside every
# releases\vX.Y.Z\ tree. The launcher exports it to <install>\venv.
$venvDir = if ($env:SIDECAR_VENV_DIR) { $env:SIDECAR_VENV_DIR } else { Join-Path $here ".venv" }
$venvPython = Join-Path $venvDir "Scripts\python.exe"
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

# Supervisor loop. main.py self-exits with one of two recoverable codes:
#   42 = CUDA device-side assert (context corrupted for the process lifetime;
#        only a fresh interpreter recovers).
#   43 = planned recycle (the memory watchdog self-exits when committed RAM or
#        reserved VRAM crosses the configured ceiling -- a fresh process resets
#        the leaked/spilled pool). This is REQUESTED recycling, not a crash, so
#        it must relaunch too; before this was added, a recycle mid-run left the
#        sidecar dead ("not restarting") and bulk voice design halted on the
#        next call.
# On either, we relaunch uvicorn so the next request hits a clean process --
# model lazy-loads on the first call, ~30-60 s on cold cache. Any other exit
# code (0 normal shutdown, 1 syntax / import error, 130 Ctrl+C, etc.) breaks
# the loop so a real bug doesn't trap the supervisor in a tight crash-respawn
# cycle. The decision lives in sidecar-restart-policy.ps1 (unit-tested).
#
# stop-app.ps1 kills the whole process tree via `taskkill /T`, so this
# loop tears down cleanly when the user invokes Stop -- the wrapper
# PowerShell receives the kill alongside its uvicorn child.
#
# ASCII-only by design: Windows PowerShell 5.1 reads UTF-8-without-BOM as
# Windows-1252, which mojibakes em-dash bytes into a control character
# and breaks the parser at the surrounding `try { ... } finally`. Keep
# this whole block ASCII so the parser stays happy regardless of how the
# file is saved.
. (Join-Path $here "sidecar-restart-policy.ps1")
$RestartBackoffSec = 2

Push-Location $here
try {
    while ($true) {
        & $venvPython -m uvicorn main:app --host $bindHost --port $port
        $code = $LASTEXITCODE
        if (Test-SidecarShouldRestart -ExitCode $code) {
            $reason = if ($code -eq 42) { "poison code $code (clean CUDA context)" } else { "recycle code $code (reset leaked/spilled memory)" }
            Write-Host "[supervisor] sidecar exited with $reason - restarting in $RestartBackoffSec seconds."
            Start-Sleep -Seconds $RestartBackoffSec
            continue
        }
        Write-Host "[supervisor] sidecar exited with code $code - not restarting."
        break
    }
} finally {
    Pop-Location
}
