#requires -Version 5.1
# Pester 5.x tests for scripts\lib\prevent-sleep.psm1. Invoke via scripts\tests\run.ps1.

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot "..\lib\prevent-sleep.psm1"
    Import-Module $modulePath -Force
}

Describe 'Set-SystemAwake / Reset-SystemAwake' {
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
