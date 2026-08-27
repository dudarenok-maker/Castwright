# Get-GoldenBlessPytestArgs -- pure helper extracted from
# server\tts-sidecar\run-golden-tests.ps1 (#1994 review) so its bare-bless
# guard is unit-testable without running the real script (which needs a
# bootstrapped venv AND actual engine weights present to reach this logic --
# scripts\tests\run-golden-tests.Tests.ps1's stub-module harness deliberately
# stops at the earlier "no golden weights found" SKIP and never reaches it).
#
# Builds the final pytest argv for a golden-audio Suite A run. A bare bless
# (GOLDEN_BLESS set, no caller-supplied -k) must not silently re-bless
# qwen-duration-baseline.json alongside kokoro-baseline.json / instruct-
# baseline.json -- Qwen duration requires an explicit selector -- so this
# appends `-k 'not qwen_duration'` in that one case, and only that case.
#
# Two shapes this must get right (both found by review after the naive
# version shipped):
#   1. "set" must mean what Python's own GOLDEN_BLESS predicate means
#      (`in ("1", "true", "TRUE")`), not PowerShell's default
#      any-non-empty-string truthiness -- '0' is PowerShell-truthy but
#      Python-false, so a plain -and would wrongly deselect Qwen duration
#      from an ordinary (non-bless) assertion run.
#   2. a caller-supplied -k can arrive as a separate token (`-k`, `EXPR`) OR
#      pytest's attached short-option form (`-kEXPR`) -- checking only the
#      separate-token form misses the attached one, and (verified against a
#      real pytest) the LAST -k on the command line wins, so appending a
#      second `-k 'not qwen_duration'` after a caller's `-kqwen_duration`
#      would silently re-bless Kokoro/instruct instead of Qwen duration --
#      the opposite of what the caller asked for.
#
# ASCII-only by design (see CLAUDE.md / feedback_powershell_ascii_only).

function Get-GoldenBlessPytestArgs {
    param(
        [Parameter(Mandatory)][string]$TestsDir,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$CallerArgs,
        [AllowNull()][string]$GoldenBlessEnvValue
    )

    $blessing = $GoldenBlessEnvValue -in @('1', 'true', 'TRUE')
    $hasKFilter = ($CallerArgs | Where-Object { $_ -eq '-k' -or $_ -match '^-k\S' }) -ne $null

    $pytestArgs = @($TestsDir, '-m', 'golden', '--tb=short', '-q', '-rs') + $CallerArgs
    if ($blessing -and -not $hasKFilter) {
        $pytestArgs += @('-k', 'not qwen_duration')
    }
    return $pytestArgs
}
