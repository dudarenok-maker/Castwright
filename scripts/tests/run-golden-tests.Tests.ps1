#requires -Version 5.1
# Pester 5.x regression for run-golden-tests.ps1's Qwen-probe stderr fix (#1892).
#
# server\tts-sidecar\run-golden-tests.ps1's Qwen-weights probe crashed the
# whole gate on any box without `sox` on PATH: `import qwen_tts` pulls in
# torchaudio, which writes a warning line to stderr when it can't find sox.
# Under Windows PowerShell 5.1's `$ErrorActionPreference = 'Stop'` (set at
# the top of that script), redirecting a NATIVE command's stderr (even to
# $null via `*>`) wraps each stderr line in a terminating ErrorRecord — so
# the probe died even though the underlying process exited 0. This pins the
# exact mechanism the fix relies on: locally relaxing
# $ErrorActionPreference to 'Continue' around the redirected native call
# lets a stray stderr line pass through without aborting the caller, and
# $LASTEXITCODE (not "no error was thrown") is the correct presence signal.
#
# A real python/qwen_tts/sox repro isn't portable to every dev box or CI
# runner, so this exercises the identical PowerShell contract — a native
# command that writes to stderr and exits 0, invoked through `*> $null` —
# using powershell.exe itself as the stand-in native process (any Windows
# box has one). Reproduced directly against the real script + a real
# sox-less venv on the dev box: crashed before this fix (exit 1, a
# NativeCommandError naming 'sox'), ran the real Qwen golden clean after
# (exit 0, "1 passed, 6 skipped").

BeforeAll {
    # A native command that writes one stderr line and exits 0 — the exact
    # shape `import qwen_tts` produces when sox is missing.
    function Invoke-StderrThenExit0 {
        & powershell.exe -NoProfile -NonInteractive -Command 'Write-Error "sox is not recognized" -ErrorAction Continue; exit 0' *> $null
    }
}

Describe 'run-golden-tests.ps1 Qwen-probe stderr handling (#1892)' {
    It 'reproduces the pre-fix crash: $ErrorActionPreference=Stop + redirected native stderr throws even on a clean exit' {
        $ErrorActionPreference = 'Stop'
        $threw = $false
        try {
            Invoke-StderrThenExit0
        } catch {
            $threw = $true
        }
        $threw | Should -Be $true
    }

    It "the fix's pattern: locally relaxing to 'Continue' around the call lets a clean exit through without throwing" {
        $ErrorActionPreference = 'Stop'
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        $threw = $false
        try {
            Invoke-StderrThenExit0
        } catch {
            $threw = $true
        } finally {
            $ErrorActionPreference = $prevEap
        }
        $threw | Should -Be $false
        $LASTEXITCODE | Should -Be 0
    }
}
