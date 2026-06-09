#requires -Version 5.1
# Pester 5.x tests for the sidecar supervisor restart policy.
# Invoke via scripts\tests\run.ps1 (npm run test:scripts).
#
# start.ps1 runs uvicorn in a supervisor loop and re-launches it on certain
# self-exit codes. The DECISION (which codes warrant a relaunch) is extracted
# into sidecar-restart-policy.ps1 so it can be unit-tested without booting
# uvicorn. Regression: code 43 (planned recycle — committed-RAM / reserved-VRAM
# ceiling self-exit) was NOT in the restart set, so a recycle mid-run left the
# sidecar dead ("not restarting") and every later request hit a down sidecar.

BeforeAll {
    $script:policy = Join-Path $PSScriptRoot "..\..\server\tts-sidecar\sidecar-restart-policy.ps1"
    . $script:policy
}

Describe 'Test-SidecarShouldRestart' {
    It 'restarts on the CUDA poison code (42)' {
        Test-SidecarShouldRestart -ExitCode 42 | Should -BeTrue
    }

    It 'restarts on the planned-recycle code (43)' {
        # The fix: a committed/VRAM-ceiling recycle MUST relaunch a fresh
        # process (that is the entire point of code 43), not stop the loop.
        Test-SidecarShouldRestart -ExitCode 43 | Should -BeTrue
    }

    It 'does NOT restart on a clean shutdown (0)' {
        Test-SidecarShouldRestart -ExitCode 0 | Should -BeFalse
    }

    It 'does NOT restart on an import/syntax error (1)' {
        Test-SidecarShouldRestart -ExitCode 1 | Should -BeFalse
    }

    It 'does NOT restart on Ctrl+C (130)' {
        Test-SidecarShouldRestart -ExitCode 130 | Should -BeFalse
    }
}
