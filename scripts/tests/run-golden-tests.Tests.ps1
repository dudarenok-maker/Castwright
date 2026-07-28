#requires -Version 5.1
# Pester 5.x regression for run-golden-tests.ps1's Qwen-probe stderr fix (#1892).
#
# server\tts-sidecar\run-golden-tests.ps1's Qwen-weights probe crashed the
# whole gate on any box without `sox` on PATH: `import qwen_tts` pulls in
# torchaudio, which writes a warning line to stderr when it can't find sox.
# Under Windows PowerShell 5.1's `$ErrorActionPreference = 'Stop'` (set at
# the top of that script), redirecting a NATIVE command's stderr (even to
# $null via `*>`) wraps each stderr line in a terminating ErrorRecord — so
# the probe died even though the underlying process exited 0. The fix
# (run-golden-tests.ps1:73-76) locally relaxes $ErrorActionPreference to
# 'Continue' around just that one native call.
#
# This test invokes the REAL run-golden-tests.ps1 (not a reimplementation of
# the mechanism) as a genuine child process, the same way
# scripts/run-powershell.mjs does. It doesn't need a real qwen_tts/torch
# install, a real GPU, or a genuinely sox-less PATH: `fixtures/
# run-golden-tests-stub-modules/` shadows `qwen_tts`/`torch`/`TTS` onto
# sys.path via PYTHONPATH, ahead of the real sidecar venv's site-packages —
# `qwen_tts.py` reproduces the one side effect that matters (a native
# stderr write on import), `torch.py` deterministically reports no CUDA, and
# `TTS.py` deterministically reports "not present" (see that file's own
# comment for why it's a silent exit rather than a raised ImportError). With
# `KOKORO_MODEL_PATH`/`KOKORO_VOICES_PATH` also pointed at paths that don't
# exist, the real script is forced down its actual Qwen-probe code path
# regardless of what happens to be installed on the box running this test,
# then lands cleanly on its "no golden weights found" SKIP banner — so this
# test never launches a real (heavy, GPU-dependent) golden pytest run.
#
# Needs only the sidecar venv to be bootstrapped (server\tts-sidecar\.venv,
# same prerequisite `npm run test:sidecar` already has) — SKIPs with the same
# banner convention when it isn't, rather than failing a fresh clone.
#
# Verified by hand against this exact fixture set (see the gate1 fix report
# for the transcript): reverting run-golden-tests.ps1:73-76 (dropping the
# $ErrorActionPreference='Continue' wrap) makes this test's real-script
# invocation exit 1 with a NativeCommandError naming the stub's stderr line,
# instead of the fixed script's clean exit 0.
#
# ASCII-only by design (see CLAUDE.md / feedback_powershell_ascii_only).

BeforeAll {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    $script:realScript = Join-Path $repoRoot 'server\tts-sidecar\run-golden-tests.ps1'
    $script:venvPython = Join-Path $repoRoot 'server\tts-sidecar\.venv\Scripts\python.exe'
    $script:stubModulesDir = Join-Path $PSScriptRoot 'fixtures\run-golden-tests-stub-modules'
    $script:venvAvailable = Test-Path $script:venvPython
}

Describe 'run-golden-tests.ps1 Qwen-probe stderr handling (#1892)' {
    It 'invokes the REAL script and exits 0 (not a NativeCommandError) through the actual Qwen-probe line' {
        if (-not $script:venvAvailable) {
            Set-ItResult -Skipped -Because "sidecar venv not bootstrapped at $script:venvPython -- bootstrap it (see npm run test:sidecar's own SKIP banner) to exercise this regression for real."
            return
        }

        $prevPythonPath = $env:PYTHONPATH
        $prevKokoroModel = $env:KOKORO_MODEL_PATH
        $prevKokoroVoices = $env:KOKORO_VOICES_PATH
        try {
            $env:PYTHONPATH = $script:stubModulesDir
            $env:KOKORO_MODEL_PATH = 'C:\does-not-exist\run-golden-tests-1892-test\kokoro.onnx'
            $env:KOKORO_VOICES_PATH = 'C:\does-not-exist\run-golden-tests-1892-test\voices.bin'

            $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script:realScript 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $env:PYTHONPATH = $prevPythonPath
            $env:KOKORO_MODEL_PATH = $prevKokoroModel
            $env:KOKORO_VOICES_PATH = $prevKokoroVoices
        }

        # Pre-fix, this is exit 1 with a NativeCommandError naming the stub's
        # stderr line (the same shape the fix's own doc comment describes).
        # Post-fix, the script reaches its own "no golden weights found" SKIP
        # banner cleanly.
        $exitCode | Should -Be 0
        ($output -join "`n") | Should -Match 'no golden weights found'
    }
}
