#requires -Version 5.1
# Pester 5.x tests for scripts\lib\prevent-sleep.psm1. Invoke via scripts\tests\run.ps1.

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot "..\lib\prevent-sleep.psm1"
    Import-Module $modulePath -Force
}

Describe 'Set-SystemAwake / Reset-SystemAwake' -Skip:($env:OS -ne 'Windows_NT') {
    # The underlying SetThreadExecutionState P/Invoke is Windows-only —
    # kernel32.dll doesn't exist on the Linux CI runner (npm run verify runs
    # cross-platform via pwsh), so these tests are a no-op there rather than a
    # false failure. $env:OS is 'Windows_NT' only on Windows, in both Windows
    # PowerShell 5.1 and pwsh (unlike $IsWindows, which 5.1 doesn't define).
    AfterEach {
        # Don't leave the test run itself holding ES_SYSTEM_REQUIRED.
        Reset-SystemAwake | Out-Null
    }

    It 'asserts ES_SYSTEM_REQUIRED successfully' {
        Set-SystemAwake | Should -BeTrue
    }

    It 'can be called repeatedly (idempotent re-assertion, matching the keep-alive loop)' {
        Set-SystemAwake | Should -BeTrue
        Set-SystemAwake | Should -BeTrue
    }

    It 'Reset-SystemAwake releases the hold successfully' {
        Set-SystemAwake | Should -BeTrue
        Reset-SystemAwake | Should -BeTrue
    }
}
