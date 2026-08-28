#requires -Version 5.1
# Pester 5.x regression for Get-GoldenBlessPytestArgs (scripts\lib\golden-bless-pytest-args.ps1),
# extracted from server\tts-sidecar\run-golden-tests.ps1's bare-bless guard
# (#1994 review). run-golden-tests.Tests.ps1 exercises the real script end to
# end but its stub-module harness deliberately stops at the earlier
# "no golden weights found" SKIP -- it never has real weights on hand to
# reach the pytest-invocation code this file's logic controls. This tests
# the extracted, pure logic directly instead.
#
# Three real bugs review found across two naive versions, all regression-
# tested here:
#   - GOLDEN_BLESS='0' is PowerShell-truthy but must NOT be treated as
#     "blessing" (Python's own predicate is `in ("1", "true", "TRUE")`) --
#     a plain truthiness check would wrongly deselect Qwen duration from an
#     ordinary, non-bless assertion run.
#   - GOLDEN_BLESS='True' (PowerShell's own `[string]$true` cast) must NOT
#     match either -- `-in` is case-INsensitive by default, so a naive
#     `-in @('1','true','TRUE')` matches "True" even though Python's exact
#     tuple-membership test does not. Needs `-cin`.
#   - a caller's attached `-kEXPR` (pytest's short-option form) must be
#     recognised as "the caller already supplied a -k filter" the same as
#     a separate `-k EXPR` token -- otherwise a deliberate
#     `-kqwen_duration` bless gets a second, LAST-WINS `-k 'not
#     qwen_duration'` appended after it, silently re-blessing
#     Kokoro/instruct instead of the Qwen duration baseline the caller
#     asked for.
#
# Assertions check the FULL returned argv array (equality), not just
# `-Contain` on individual tokens -- a `-Contain`-only suite stays green
# even if `-m`/`golden`/`--tb=short`/`-rs`/$TestsDir get silently dropped
# from the pytest invocation, since none of those tokens is what any single
# `-Contain` check happens to look for. Confirmed by review: that shape
# passed 7/7 while missing four of the function's nine base tokens.
#
# ASCII-only by design (see CLAUDE.md / feedback_powershell_ascii_only).

BeforeAll {
    $repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    . (Join-Path $repoRoot 'scripts\lib\golden-bless-pytest-args.ps1')
}

Describe 'Get-GoldenBlessPytestArgs' {
    It 'builds the exact base argv for an ordinary (non-bless) run with no caller args' {
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue $null
        ($result -join '|') | Should -Be ((@('tests\golden', '-m', 'golden', '--tb=short', '-q', '-rs')) -join '|')
    }

    It 'appends "not qwen_duration" for a bare bless with no caller -k, base argv intact' {
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue '1'
        ($result -join '|') | Should -Be ((@('tests\golden', '-m', 'golden', '--tb=short', '-q', '-rs', '-k', 'not qwen_duration')) -join '|')
    }

    It 'accepts GOLDEN_BLESS=true and =TRUE the same as =1 (matches the Python predicate)' {
        foreach ($v in @('true', 'TRUE')) {
            $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue $v
            ($result -join '|') | Should -Be ((@('tests\golden', '-m', 'golden', '--tb=short', '-q', '-rs', '-k', 'not qwen_duration')) -join '|')
        }
    }

    It 'does NOT treat GOLDEN_BLESS=0 as blessing (PowerShell-truthy, Python-false)' {
        # Regression for the first version's bug: a plain `$env:GOLDEN_BLESS -and ...`
        # treats the non-empty string '0' as true, wrongly deselecting Qwen
        # duration from what Python's own predicate treats as a normal,
        # non-bless assertion run.
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue '0'
        ($result -join '|') | Should -Be ((@('tests\golden', '-m', 'golden', '--tb=short', '-q', '-rs')) -join '|')
    }

    It 'does NOT treat GOLDEN_BLESS=True (capital-T only) as blessing (case-sensitive match)' {
        # Regression for the second version's bug: PowerShell's `-in` is
        # case-INsensitive by default, so a naive `-in @('1','true','TRUE')`
        # matches "True" -- a spelling Python's exact-membership predicate
        # does not treat as set. Needs `-cin`.
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @() -GoldenBlessEnvValue 'True'
        ($result -join '|') | Should -Be ((@('tests\golden', '-m', 'golden', '--tb=short', '-q', '-rs')) -join '|')
    }

    It 'does not double-apply when the caller already passed a separate -k token' {
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @('-k', 'qwen_duration') -GoldenBlessEnvValue '1'
        ($result -join '|') | Should -Be ((@('tests\golden', '-m', 'golden', '--tb=short', '-q', '-rs', '-k', 'qwen_duration')) -join '|')
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
        ($result -join '|') | Should -Be ((@('tests\golden', '-m', 'golden', '--tb=short', '-q', '-rs', '-kqwen_duration')) -join '|')
    }

    It 'still runs an --engine=qwen-shaped -k EXPR bless without the exclusion filter' {
        $result = Get-GoldenBlessPytestArgs -TestsDir 'tests\golden' -CallerArgs @('-k', 'qwen') -GoldenBlessEnvValue '1'
        ($result -join '|') | Should -Be ((@('tests\golden', '-m', 'golden', '--tb=short', '-q', '-rs', '-k', 'qwen')) -join '|')
    }
}
