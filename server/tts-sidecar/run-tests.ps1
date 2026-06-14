#requires -Version 5.1
# Pytest runner for the TTS sidecar test suite.
#
# Wired into `npm run test:all` (and therefore the pre-push gate). A fresh
# clone won't have the sidecar venv bootstrapped yet, so this runner emits a
# loud SKIP banner and exits 0 when the venv (or pytest inside it) is
# missing -- the rest of the gate still runs. Same convention as the Pester
# runner's "install Pester" hint at scripts/tests/run.ps1.
#
# ASCII-only by design (see CLAUDE.md / feedback_powershell_ascii_only).

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $here ".venv\Scripts\python.exe"
$testsDir = Join-Path $here "tests"

if (-not (Test-Path $venvPython)) {
    Write-Host ""
    Write-Host "SKIP: sidecar pytest -- venv not found at $venvPython"
    Write-Host "      Bootstrap once to enable this block in the gate:"
    Write-Host "        cd server\tts-sidecar"
    Write-Host "        py -3.12 -m venv .venv"
    Write-Host "        .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
    Write-Host "        .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt   # pytest + httpx (tests)"
    Write-Host ""
    exit 0
}

# Probe pytest. `--version` is a fast no-op that fails cheaply if pytest
# isn't installed in the venv yet. NOTE: temporarily relax ErrorActionPreference
# around the probe -- when pytest is missing the native command writes to stderr,
# and under 'Stop' PowerShell 5.1 wraps that in a NativeCommandError and THROWS
# before we can branch on $LASTEXITCODE (so the SKIP below never fired and the
# gate failed instead of skipping). 'Continue' lets the exit code drive the skip.
$ErrorActionPreference = 'Continue'
& $venvPython -m pytest --version *> $null
$pytestProbe = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($pytestProbe -ne 0) {
    Write-Host ""
    Write-Host "SKIP: sidecar pytest -- pytest not installed in the sidecar venv."
    Write-Host "      Test deps are separate from the runtime requirements; install with:"
    Write-Host "        .\.venv\Scripts\python.exe -m pip install -r server\tts-sidecar\requirements-dev.txt"
    Write-Host ""
    exit 0
}

Push-Location $here
try {
    # `-m "not golden"` excludes the opt-in real-model golden-audio tier (ops-11)
    # so this fast tier stays model-free. Run the goldens via run-golden-tests.ps1
    # (npm run test:golden-audio). The pure-logic golden helpers
    # (tests/golden/test_golden_compare.py) carry NO marker and DO run here.
    & $venvPython -m pytest $testsDir -m "not golden" --tb=short -q
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

exit $code
