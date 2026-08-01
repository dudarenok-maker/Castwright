#requires -Version 5.1
# Golden-audio regression runner (ops-11) — Suite A: the REAL-model goldens.
#
# Triple-gated, each gate emits a SKIP banner and exits 0 (never fails the
# caller) so a fresh clone / CI without the sidecar venv or any engine weights
# is a clean SKIP, exactly like run-tests.ps1's venv gate:
#   1. sidecar venv python missing,
#   2. pytest not installed in the venv,
#   3. no engine present -- Kokoro weights (kokoro-v1.0.onnx +
#      voices-v1.0.bin), Qwen (qwen_tts + CUDA), and Coqui (`import TTS`) are
#      all missing.
#
# Otherwise runs ONLY the `-m golden` tests (the model-free golden helper unit
# test stays in the fast `test:sidecar` tier). Extra args are forwarded to
# pytest, so the orchestrator can pass `-k coqui` etc. Set GOLDEN_BLESS=1 to
# record the baseline instead of asserting. GOLDEN_ASR=0 disables the
# ops-45 / #1911 content-drift check for this run (still SKIPs everything
# else per the usual gates); GOLDEN_REBLESS_CONTENT=1 additionally permits a
# `--bless` to overwrite a DIFFERING recorded transcript (see
# compare.bless_guard's G1). GOLDEN_REBLESS_THRESHOLDS=1 is the sibling flag
# for instruct-baseline.json's tolerances/identity/loudness_dbfs blocks --
# required whenever a `--bless` would move `tolerances` (any change; it's a
# quantised THRESHOLD, #1995) or move `identity`/`loudness_dbfs` beyond a
# noise-tolerant epsilon (they're raw stochastic measurements; a move
# smaller than that is written and echoed to stdout, not refused, so a
# routine re-bless doesn't need the flag -- see compare.bless_guard_thresholds
# and compare.describe_measurement_move, #1995/#2035/#2045).
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

# Weights gate. The golden suite spans Kokoro (length goldens), Qwen (the
# 1.7B live-instruct golden, #1099), and Coqui (cross-engine clone sanity),
# so proceed when ANY of the three is present -- a single-engine box must
# still run its own goldens. Each test self-gates on its own engine (and its
# own opt-in env flag), so a present-but-wrong-engine box is a clean
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
#
# `import qwen_tts` pulls in torchaudio, which probes for a `sox` binary on
# PATH and (when absent) prints a warning line to stderr. Under Windows
# PowerShell 5.1's `$ErrorActionPreference = 'Stop'` (set at the top of this
# script), redirecting a native command's stderr wraps EACH stderr line in a
# terminating ErrorRecord -- so this probe crashed the whole gate even though
# python itself exited cleanly. Locally relax to 'Continue' for just this
# call so a stray stderr line can't abort the script; $LASTEXITCODE (not the
# absence of a thrown error) is the actual presence signal either way.
$qwenPresent = $false
if (-not $kokoroPresent) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $venvPython -c "import sys, qwen_tts, torch; sys.exit(0 if torch.cuda.is_available() else 1)" *> $null
    $ErrorActionPreference = $prevEap
    if ($LASTEXITCODE -eq 0) { $qwenPresent = $true }
}

# Coqui-presence probe -- only when neither Kokoro nor Qwen is present (same
# lazy-probe philosophy as the Qwen check above). Method: `import TTS`, NOT a
# weights-path test -- XTTS weights are fetched lazily by the coqui-tts
# library on first load, so there is no fixed path to check ahead of time the
# way Kokoro's ONNX files or Qwen's designed-voice .pt exist on disk. Without
# this probe, a Coqui-only box (no Kokoro weights, no importable qwen_tts) hit
# the "no golden weights found" SKIP below and exited 0 before pytest ever
# ran -- so `test_coqui_sanity` never executed even with GOLDEN_COQUI=1.
#
# Same $ErrorActionPreference relaxation as the Qwen probe above, and for the
# identical reason (#1892): `import TTS` writes to stderr on plenty of boxes --
# a torch/transformers deprecation notice, a CUDA notice, or coqui-tts's own
# import chatter -- and under PowerShell 5.1's `$ErrorActionPreference = 'Stop'`
# redirecting a NATIVE command's stderr wraps each line in a terminating
# NativeCommandError, killing the whole gate even when python exited 0. This
# probe had the same shape as the Qwen one but not the same guard; the stub
# fixture added for #1892 had to be written deliberately SILENT to route around
# it (see scripts\tests\fixtures\run-golden-tests-stub-modules\TTS.py, which
# names this as a latent second instance). $LASTEXITCODE, not the absence of a
# thrown error, is the presence signal either way.
$coquiPresent = $false
if (-not $kokoroPresent -and -not $qwenPresent) {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $venvPython -c "import TTS" *> $null
    $ErrorActionPreference = $prevEap
    if ($LASTEXITCODE -eq 0) { $coquiPresent = $true }
}

if (-not $kokoroPresent -and -not $qwenPresent -and -not $coquiPresent) {
    Write-Host ""
    Write-Host "SKIP: golden-audio -- no golden weights found (Kokoro, Qwen, or Coqui)."
    Write-Host "        kokoro model:  $modelPath"
    Write-Host "        kokoro voices: $voicesPath"
    Write-Host "      Install Kokoro:  server\tts-sidecar\scripts\install-kokoro.ps1"
    Write-Host "      Install Qwen:    node scripts\install-qwen3.mjs"
    Write-Host "      Install Coqui:   node scripts\install-coqui.mjs"
    Write-Host ""
    exit 0
}

Push-Location $here
try {
    # -rs (ops-45 / #1911 s5): print the reason for every SKIP. Without it a
    # skip is a single "s" and GOLDEN_ASR=0 (or an unblessed baseline) is an
    # invisible off-switch -- addopts in pytest.ini is just `-q`, with no
    # -rs/-ra of its own.
    & $venvPython -m pytest $testsDir -m golden --tb=short -q -rs @args
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

exit $code
