#requires -Version 5.1
# Golden-audio regression runner (ops-11) — Suite A: the REAL-model goldens.
#
# Triple-gated, each gate emits a SKIP banner and exits 0 (never fails the
# caller) so a fresh clone / CI without the sidecar venv or Kokoro weights is a
# clean SKIP, exactly like run-tests.ps1's venv gate:
#   1. sidecar venv python missing,
#   2. pytest not installed in the venv,
#   3. Kokoro weights (kokoro-v1.0.onnx + voices-v1.0.bin) missing.
#
# Otherwise runs ONLY the `-m golden` tests (the model-free golden helper unit
# test stays in the fast `test:sidecar` tier). Extra args are forwarded to
# pytest, so the orchestrator can pass `-k coqui` etc. Set GOLDEN_BLESS=1 to
# record the baseline instead of asserting.
#
# ASCII-only by design (see CLAUDE.md / feedback_powershell_ascii_only).

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $here ".venv\Scripts\python.exe"
$testsDir = Join-Path $here "tests\golden"

if (-not (Test-Path $venvPython)) {
    Write-Host ""
    Write-Host "SKIP: golden-audio -- sidecar venv not found at $venvPython"
    Write-Host "      Bootstrap once to enable this gate:"
    Write-Host "        cd server\tts-sidecar"
    Write-Host "        python -m venv .venv"
    Write-Host "        .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
    Write-Host ""
    exit 0
}

& $venvPython -m pytest --version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "SKIP: golden-audio -- pytest not installed in the sidecar venv."
    Write-Host "      .\.venv\Scripts\python.exe -m pip install -r server\tts-sidecar\requirements.txt"
    Write-Host ""
    exit 0
}

# Weights gate. The golden suite spans Kokoro (length goldens) AND Qwen (the
# 1.7B live-instruct golden, #1099), so proceed when EITHER weight set is
# present -- a Qwen-only box must still run the instruct golden. Each test
# self-gates on its own engine, so a present-but-wrong-engine box is a clean
# per-test SKIP. Honor KOKORO_MODEL_PATH / KOKORO_VOICES_PATH env overrides;
# otherwise the default download location next to main.py.
$modelPath = $env:KOKORO_MODEL_PATH
if (-not $modelPath) { $modelPath = Join-Path $here "voices\kokoro\kokoro-v1.0.onnx" }
$voicesPath = $env:KOKORO_VOICES_PATH
if (-not $voicesPath) { $voicesPath = Join-Path $here "voices\kokoro\voices-v1.0.bin" }
$kokoroPresent = (Test-Path $modelPath) -and (Test-Path $voicesPath)

# Qwen-weights probe -- only when Kokoro is absent (importing torch costs a few
# seconds; skip it on the common Kokoro-present path). Same check the Python
# tests use: qwen_tts importable AND a CUDA device.
$qwenPresent = $false
if (-not $kokoroPresent) {
    & $venvPython -c "import sys, qwen_tts, torch; sys.exit(0 if torch.cuda.is_available() else 1)" *> $null
    if ($LASTEXITCODE -eq 0) { $qwenPresent = $true }
}

if (-not $kokoroPresent -and -not $qwenPresent) {
    Write-Host ""
    Write-Host "SKIP: golden-audio -- no golden weights found (Kokoro or Qwen)."
    Write-Host "        kokoro model:  $modelPath"
    Write-Host "        kokoro voices: $voicesPath"
    Write-Host "      Install Kokoro:  server\tts-sidecar\scripts\install-kokoro.ps1"
    Write-Host "      Install Qwen:    node scripts\install-qwen3.mjs"
    Write-Host ""
    exit 0
}

Push-Location $here
try {
    & $venvPython -m pytest $testsDir -m golden --tb=short -q @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

exit $code
