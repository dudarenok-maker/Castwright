#requires -Version 5.1
# Pester 5.x regression for Get-GoldenBlessPytestArgs (scripts\lib\golden-bless-pytest-args.ps1),
# extracted from server\tts-sidecar\run-golden-tests.ps1's bare-bless guard
# (#1994 review). run-golden-tests.Tests.ps1 exercises the real script end to
# end but its stub-module harness deliberately stops at the earlier
# "no golden weights found" SKIP -- it never has real weights on hand to
# reach the pytest-invocation code this file's logic controls. This tests
# the extracted, pure logic directly instead.
#
# Two real bugs review found in the naive first version, both regression-
# tested here:
#   - GOLDEN_BLESS='0' is PowerShell-truthy but must NOT be treated as
#     "blessing" (Python's own predicate is `in ("1", "true", "TRUE")`) --
#     a plain truthiness check would wrongly deselect Qwen duration from an
#     ordinary, non-bless assertion run.
#   - a caller's attached `-kEXPR` (pytest's short-option form) must be
#     recognised as "the caller already supplied a -k filter" the same as
#     a separate `-k EXPR` token -- otherwise a deliberate
#     `-kqwen_duration` bless gets a second, LAST-WINS `-k 'not
#     qwen_duration'` appended after it, silently re-blessing
#     Kokoro/instruct instead of the Qwen duration baseline the caller
#     asked for.
#
# ASCII-only by design (see CLAUDE.md / feedback_powershell_ascii_only).

BeforeAll {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    . (Join-Path $repoRoot 'scripts\lib\golden-bless-pytest-args.ps1')
}

Describe 'Get-GoldenBlessPytestArgs' {
    It 'does not append a -k filter for an ordinary (non-bless) run' {
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue $null
        $result | Should -Not -Contain '-k'
    }

    It 'appends "not qwen_duration" for a bare bless with no caller -k' {
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue '1'
        $result[-2] | Should -Be '-k'
        $result[-1] | Should -Be 'not qwen_duration'
    }

    It 'accepts GOLDEN_BLESS=true and =TRUE the same as =1 (matches the Python predicate)' {
        foreach ($v in @('true', 'TRUE')) {
            $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue $v
            $result[-2] | Should -Be '-k'
            $result[-1] | Should -Be 'not qwen_duration'
        }
    }

    It 'does NOT treat GOLDEN_BLESS=0 as blessing (PowerShell-truthy, Python-false)' {
        # Regression for the first version's bug: a plain `$env:GOLDEN_BLESS -and ...`
        # treats the non-empty string '0' as true, wrongly deselecting Qwen
        # duration from what Python's own predicate treats as a normal,
        # non-bless assertion run.
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue '0'
        $result | Should -Not -Contain '-k'
    }

    It 'does not double-apply when the caller already passed a separate -k token' {
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @('-k', 'qwen_duration') -GoldenBlessEnvValue '1'
        ($result | Where-Object { $_ -eq '-k' }).Count | Should -Be 1
        $result[-1] | Should -Be 'qwen_duration'
    }

    It 'does not double-apply when the caller passed pytest''s attached -kEXPR form' {
        # Regression for the first version's bug: `-contains '-k'` only
        # matches a SEPARATE '-k' token, missing the attached short-option
        # form pytest also accepts. Verified against a real pytest: the
        # LAST -k on the command line wins, so appending a second one after
        # a caller's `-kqwen_duration` would silently re-bless
        # Kokoro/instruct instead of Qwen duration -- the opposite of what
        # was asked for.
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @('-kqwen_duration') -GoldenBlessEnvValue '1'
        ($result | Where-Object { $_ -match '^-k' }).Count | Should -Be 1
        $result | Should -Contain '-kqwen_duration'
        $result | Should -Not -Contain 'not qwen_duration'
    }

    It 'still runs an --engine=qwen-shaped -k EXPR bless without the exclusion filter' {
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @('-k', 'qwen') -GoldenBlessEnvValue '1'
        $result | Should -Contain 'qwen'
        $result | Should -Not -Contain 'not qwen_duration'
    }
}
