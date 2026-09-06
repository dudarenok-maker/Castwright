#requires -Version 5.1
# Pester 5.x tests for scripts\lib\wt-gc-junctions.psm1. Invoke via
# scripts\tests\run.ps1 (npm run test:scripts).
#
# Covers: junction detection is gated on the ReparsePoint attribute (never
# `.LinkTarget`, source-pinned below); recursion never descends INTO a found
# junction; removal unlinks the junction but leaves its target's own content
# untouched; removal is verified by Test-Path, not by "the call didn't
# throw"; an enumeration error FAILS CLOSED (throws) rather than answering
# "no junctions found"; and the result objects' property names match
# wt-gc.mjs's JUNCTION_RESULT_KEYS.

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot "..\lib\wt-gc-junctions.psm1"
    Import-Module $modulePath -Force
    $script:modulePath = $modulePath

    # A real junction requires elevation-free `New-Item -ItemType Junction`
    # (unlike symlinks, junctions need no admin rights on Windows). Defined
    # inside this top-level BeforeAll — not as a bare script-level function —
    # so it is dot-sourced into every Describe/It's run-phase scope; a plain
    # function declared outside any Pester block is only visible during
    # discovery, not during the run phase, and is unresolved from an `It`.
    function script:New-TestJunction {
        param(
            [Parameter(Mandatory)] [string] $LinkPath,
            [Parameter(Mandatory)] [string] $TargetPath
        )
        New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
    }
}

Describe 'Test-IsReparsePoint' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "wtgc-reparse-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            # Never Remove-Item -Recurse over a tree that might still hold a
            # live junction in these tests' own fixtures — remove the
            # junction link explicitly first, exactly like the module under
            # test must, then the (now link-free) tree is safe to recurse.
            Get-ChildItem -Path $script:tempDir -Directory -Force -ErrorAction SilentlyContinue |
                Where-Object { Test-IsReparsePoint -Item $_ } |
                ForEach-Object { [System.IO.Directory]::Delete($_.FullName, $false) }
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'returns $false for an ordinary directory' {
        $dir = Join-Path $script:tempDir "plain"
        New-Item -ItemType Directory -Path $dir | Out-Null
        $item = Get-Item -LiteralPath $dir -Force
        Test-IsReparsePoint -Item $item | Should -BeFalse
    }

    It 'returns $true for a real junction' {
        $target = Join-Path $script:tempDir "target"
        $link = Join-Path $script:tempDir "link"
        New-Item -ItemType Directory -Path $target | Out-Null
        New-TestJunction -LinkPath $link -TargetPath $target

        $item = Get-Item -LiteralPath $link -Force
        Test-IsReparsePoint -Item $item | Should -BeTrue
    }
}

Describe 'Get-JunctionsRecursive' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "wtgc-find-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Get-ChildItem -Path $script:tempDir -Directory -Force -Recurse -ErrorAction SilentlyContinue |
                Where-Object { Test-IsReparsePoint -Item $_ } |
                Sort-Object { $_.FullName.Length } -Descending |
                ForEach-Object { try { [System.IO.Directory]::Delete($_.FullName, $false) } catch {} }
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'returns an empty array for a root with no junctions' {
        $sub = Join-Path $script:tempDir "plain-subdir"
        New-Item -ItemType Directory -Path $sub | Out-Null

        $found = Get-JunctionsRecursive -Root $script:tempDir

        # `-is [array]` on the captured variable, not `Should -BeOfType`
        # piped from an empty array — piping zero elements hands Should
        # $null regardless of the underlying type, which would pass this
        # assertion vacuously for the wrong reason.
        ($found -is [array]) | Should -BeTrue
        $found.Count | Should -Be 0
    }

    It 'finds a junction at the root level' {
        $target = Join-Path $script:tempDir "real-node-modules"
        $link = Join-Path $script:tempDir "node_modules"
        New-Item -ItemType Directory -Path $target | Out-Null
        New-TestJunction -LinkPath $link -TargetPath $target

        $found = Get-JunctionsRecursive -Root $script:tempDir

        $found.Count | Should -Be 1
        $found[0] | Should -Be $link
    }

    It 'finds a junction three levels deep (the server/tts-sidecar/.venv shape, #3051)' {
        $nested = Join-Path $script:tempDir "server\tts-sidecar"
        New-Item -ItemType Directory -Path $nested -Force | Out-Null
        $target = Join-Path $script:tempDir "real-venv"
        $link = Join-Path $nested ".venv"
        New-Item -ItemType Directory -Path $target | Out-Null
        New-TestJunction -LinkPath $link -TargetPath $target

        $found = Get-JunctionsRecursive -Root $script:tempDir

        # A TOP-LEVEL-ONLY check would miss this entirely (issue #3051's
        # named regression) — assert the recursive walk actually reaches it.
        $found.Count | Should -Be 1
        $found[0] | Should -Be $link
    }

    It 'does NOT descend into a found junction (its contents live at the target, not under $Root)' {
        $target = Join-Path $script:tempDir "real-target"
        $insideTarget = Join-Path $target "should-not-be-enumerated"
        New-Item -ItemType Directory -Path $insideTarget -Force | Out-Null
        $link = Join-Path $script:tempDir "linked-dir"
        New-TestJunction -LinkPath $link -TargetPath $target

        $found = Get-JunctionsRecursive -Root $script:tempDir

        $found.Count | Should -Be 1
        $found | Should -Not -Contain (Join-Path $link "should-not-be-enumerated")
    }

    It 'finds multiple sibling junctions at different depths' {
        $t1 = Join-Path $script:tempDir "t1"; New-Item -ItemType Directory -Path $t1 | Out-Null
        $t2 = Join-Path $script:tempDir "t2"; New-Item -ItemType Directory -Path $t2 | Out-Null
        $nested = Join-Path $script:tempDir "nested"; New-Item -ItemType Directory -Path $nested | Out-Null
        $link1 = Join-Path $script:tempDir "node_modules"
        $link2 = Join-Path $nested ".venv"
        New-TestJunction -LinkPath $link1 -TargetPath $t1
        New-TestJunction -LinkPath $link2 -TargetPath $t2

        $found = Get-JunctionsRecursive -Root $script:tempDir

        $found.Count | Should -Be 2
        $found | Should -Contain $link1
        $found | Should -Contain $link2
    }
}

Describe 'Remove-JunctionsRecursive' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "wtgc-remove-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'unlinks the junction and leaves the TARGET directory and its content untouched (the load-bearing guarantee)' {
        $target = Join-Path $script:tempDir "real-node-modules"
        New-Item -ItemType Directory -Path $target | Out-Null
        $marker = Join-Path $target "package.json"
        Set-Content -Path $marker -Value '{"name":"real"}' -Encoding utf8

        $link = Join-Path $script:tempDir "node_modules"
        New-TestJunction -LinkPath $link -TargetPath $target

        $report = Remove-JunctionsRecursive -Root $script:tempDir

        $report.Count | Should -Be 1
        $report[0].Removed | Should -BeTrue
        $report[0].Error | Should -BeNullOrEmpty

        # Verification is by Test-Path, exactly as the removal function
        # itself does — never by trusting the absence of a thrown error.
        Test-Path -LiteralPath $link | Should -BeFalse
        Test-Path -LiteralPath $target | Should -BeTrue
        Test-Path -LiteralPath $marker | Should -BeTrue
        (Get-Content $marker -Raw) | Should -Match 'real'
    }

    It 'reports TargetStillExists = $true after removal (the link is gone, the real tree is not)' {
        $target = Join-Path $script:tempDir "real-venv"
        New-Item -ItemType Directory -Path $target | Out-Null
        $link = Join-Path $script:tempDir ".venv"
        New-TestJunction -LinkPath $link -TargetPath $target

        $report = Remove-JunctionsRecursive -Root $script:tempDir

        $report[0].TargetStillExists | Should -BeTrue
    }

    It 'removes multiple junctions at different depths, each independently verified' {
        $t1 = Join-Path $script:tempDir "t1"; New-Item -ItemType Directory -Path $t1 | Out-Null
        $nested = Join-Path $script:tempDir "server\tts-sidecar"; New-Item -ItemType Directory -Path $nested -Force | Out-Null
        $t2 = Join-Path $script:tempDir "t2"; New-Item -ItemType Directory -Path $t2 | Out-Null
        $link1 = Join-Path $script:tempDir "node_modules"
        $link2 = Join-Path $nested ".venv"
        New-TestJunction -LinkPath $link1 -TargetPath $t1
        New-TestJunction -LinkPath $link2 -TargetPath $t2

        $report = Remove-JunctionsRecursive -Root $script:tempDir

        $report.Count | Should -Be 2
        foreach ($r in $report) { $r.Removed | Should -BeTrue }
        Test-Path -LiteralPath $link1 | Should -BeFalse
        Test-Path -LiteralPath $link2 | Should -BeFalse
        Test-Path -LiteralPath $t1 | Should -BeTrue
        Test-Path -LiteralPath $t2 | Should -BeTrue
    }

    It 'is a no-op returning an empty array when the root has no junctions' {
        New-Item -ItemType Directory -Path (Join-Path $script:tempDir "plain") | Out-Null

        $report = Remove-JunctionsRecursive -Root $script:tempDir

        ($report -is [array]) | Should -BeTrue
        $report.Count | Should -Be 0
    }
}

# --- The scan -> delete window (#3055 pass 2). Remove-JunctionsRecursive  ---
# --- enumerates once and then deletes; a junction created in between was   ---
# --- live and unseen when the caller went on to `git worktree remove       ---
# --- --force`. It now re-scans and reports anything still there.           ---
Describe 'Remove-JunctionsRecursive re-scans after the delete pass' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "wtgc-rescan-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
        $global:WtGcScanCount = 0
        $global:WtGcLateLink = $null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            # Unlink any surviving junction FIRST -- these tests deliberately
            # leave one live, and Remove-Item -Recurse over it would follow
            # the link and delete the target, which is the exact hazard the
            # module under test exists to prevent.
            Get-ChildItem -Path $script:tempDir -Directory -Force -ErrorAction SilentlyContinue |
                Where-Object { Test-IsReparsePoint -Item $_ } |
                ForEach-Object { [System.IO.Directory]::Delete($_.FullName, $false) }
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        Remove-Variable -Name WtGcScanCount -Scope Global -ErrorAction SilentlyContinue
        Remove-Variable -Name WtGcLateLink -Scope Global -ErrorAction SilentlyContinue
    }

    It 'reports a junction that appeared AFTER the delete pass as un-removed, and does NOT sweep it' {
        $target = Join-Path $script:tempDir "real-node-modules"
        New-Item -ItemType Directory -Path $target | Out-Null
        $marker = Join-Path $target "package.json"
        Set-Content -Path $marker -Value '{"name":"real"}' -Encoding utf8
        $late = Join-Path $script:tempDir "node_modules"
        New-TestJunction -LinkPath $late -TargetPath $target
        $global:WtGcLateLink = $late

        # Mocking the enumeration is the only way to place a junction inside
        # the function's OWN scan->delete window: the first call is the
        # moment before the `npm install` finishes (clean tree, nothing to
        # delete), the second is the re-scan. Globals, not $script:, because
        # a -ModuleName mock body runs in the MODULE's session state and
        # cannot see this file's script scope.
        Mock -ModuleName wt-gc-junctions Get-JunctionsRecursive {
            $global:WtGcScanCount++
            if ($global:WtGcScanCount -eq 1) { return , @() }
            return , @($global:WtGcLateLink)
        }

        $report = Remove-JunctionsRecursive -Root $script:tempDir

        $global:WtGcScanCount | Should -Be 2
        $report.Count | Should -Be 1
        $report[0].Path | Should -Be $late
        $report[0].Removed | Should -BeFalse
        $report[0].Error | Should -Match 'AFTER the removal pass'
        # Reported, never swept -- and the target is untouched either way.
        Test-Path -LiteralPath $late | Should -BeTrue
        Test-Path -LiteralPath $marker | Should -BeTrue
    }

    It 'adds NO extra entry when the tree really is clean after the sweep (proves the re-scan is not always-reporting)' {
        $target = Join-Path $script:tempDir "real-node-modules"
        New-Item -ItemType Directory -Path $target | Out-Null
        $link = Join-Path $script:tempDir "node_modules"
        New-TestJunction -LinkPath $link -TargetPath $target

        $report = Remove-JunctionsRecursive -Root $script:tempDir

        $report.Count | Should -Be 1
        $report[0].Removed | Should -BeTrue
        $report[0].Error | Should -BeNullOrEmpty
    }
}

# --- Acceptance #4 (#3051): the ReparsePoint gate is source-pinned, and the ---
# --- pin fails if the gate is changed to `.LinkTarget`.                    ---
Describe 'ReparsePoint gate is source-pinned (#3051 acceptance 4)' {
    BeforeAll {
        $script:moduleSource = Get-Content $script:modulePath -Raw
        # Strip full-line comments before scanning for the CODE shape —
        # the module's own header prose legitimately documents `.LinkTarget`
        # (explaining why the gate avoids it), so a raw text match against
        # the whole file would trip on that explanation, not on the gate
        # itself. Every real `.LinkTarget`/ReparsePoint reference in this
        # module lives on its own line, so a per-line "starts with #" filter
        # is sufficient here (no inline trailing comments to worry about).
        $script:moduleCode = ($script:moduleSource -split "`r?`n" |
            Where-Object { $_.Trim() -notmatch '^#' }) -join "`n"
    }

    It 'gates detection on the ReparsePoint attribute bit' {
        $script:moduleCode | Should -Match '\[System\.IO\.FileAttributes\]::ReparsePoint'
    }

    It 'never gates on .LinkTarget in code -- reads empty on this box''s Windows PowerShell 5.1 even for a real junction' {
        # This is the literal acceptance criterion: if a future edit swaps
        # the ReparsePoint-attribute gate above for `.LinkTarget`, THIS
        # assertion goes red, because that edit necessarily introduces the
        # string `.LinkTarget` into the module's CODE (as opposed to its
        # prose, which is filtered out above and is allowed to keep
        # explaining the pitfall). Proven by deletion: temporarily replacing
        # the ReparsePoint-attribute check in Test-IsReparsePoint with a
        # `.LinkTarget` truthiness check reddens this exact test — see the
        # PR description / fix report for the named mutation run.
        $script:moduleCode | Should -Not -Match '\.LinkTarget'
    }
}

# --- The scan FAILS CLOSED (PR #3055 review, significant #3) -----------------
# An empty result that means "the scan failed" is indistinguishable from one
# that means "there are no junctions here" — and wt-gc.mjs acts on the second
# by running `git worktree remove --force`, which then follows the junction
# the scan never saw into the primary checkout's real node_modules/.venv.
# Measured shape: a junction at a 394-character path is found by pwsh, while
# Windows PowerShell 5.1 raised PathTooLongException inside Get-ChildItem and
# — under the old `-ErrorAction SilentlyContinue` — returned `{"items": []}`,
# exit 0, no warning. ACL-denied directories swallow the same way on both
# engines. The mocks below reproduce that class deterministically rather than
# depending on a 5.1 box or a hand-built long path.
Describe 'Get-JunctionsRecursive fails closed on an enumeration error' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "wtgc-failclosed-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:tempDir "sub") | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'THROWS when a directory cannot be enumerated, instead of reporting zero junctions' {
        Mock -ModuleName 'wt-gc-junctions' Get-ChildItem { throw 'Access to the path is denied.' }

        { Get-JunctionsRecursive -Root $script:tempDir } |
            Should -Throw -ExpectedMessage '*INCOMPLETE*'
    }

    It 'THROWS when a directory cannot be inspected (the Get-Item half of the same swallow)' {
        Mock -ModuleName 'wt-gc-junctions' Get-Item { throw 'The specified path, file name, or both are too long.' }

        { Get-JunctionsRecursive -Root $script:tempDir } |
            Should -Throw -ExpectedMessage '*INCOMPLETE*'
    }

    It 'propagates the failure out of Remove-JunctionsRecursive -- the caller must never see a clean empty report' {
        Mock -ModuleName 'wt-gc-junctions' Get-ChildItem { throw 'Access to the path is denied.' }

        { Remove-JunctionsRecursive -Root $script:tempDir } |
            Should -Throw -ExpectedMessage '*INCOMPLETE*'
    }

    It 'still returns normally (no throw) when enumeration succeeds -- proves the guard is not always-on' {
        $found = Get-JunctionsRecursive -Root $script:tempDir

        ($found -is [array]) | Should -BeTrue
        $found.Count | Should -Be 0
    }
}

# --- The .psm1 -> wt-gc.mjs property contract (PR #3055 review, significant #5) ---
# Rename `TargetStillExists` on either side and wt-gc.mjs's
# `j.TargetStillExists === false` becomes permanently false, so the
# catastrophic case — junction unlinked AND its real target destroyed — reads
# as success and `git worktree remove --force` proceeds. This is the
# PowerShell half of the pin; scripts/tests/wt-gc.test.mjs holds the JS half
# (it asserts this module's source emits each of those names).
Describe 'Junction-report property names match wt-gc.mjs JUNCTION_RESULT_KEYS' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "wtgc-contract-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'emits exactly the property set wt-gc.mjs declares' {
        $jsPath = Join-Path $PSScriptRoot "..\wt-gc.mjs"
        $js = Get-Content $jsPath -Raw
        $match = [regex]::Match($js, "JUNCTION_RESULT_KEYS\s*=\s*\[([^\]]*)\]")
        $match.Success | Should -BeTrue -Because 'wt-gc.mjs must export the key list this pin reads'
        $expected = @(
            $match.Groups[1].Value -split ',' |
                ForEach-Object { $_.Trim().Trim("'").Trim('"').Trim() } |
                Where-Object { $_ }
        )
        $expected.Count | Should -Be 5

        $target = Join-Path $script:tempDir "real-node-modules"
        New-Item -ItemType Directory -Path $target | Out-Null
        $link = Join-Path $script:tempDir "node_modules"
        New-TestJunction -LinkPath $link -TargetPath $target

        $report = Remove-JunctionsRecursive -Root $script:tempDir

        $report.Count | Should -Be 1
        $actual = @($report[0].PSObject.Properties.Name)
        (($actual | Sort-Object) -join ',') | Should -Be (($expected | Sort-Object) -join ',')
    }
}

# --- The .ps1 CLI surface (PR #3055 review, minor: dead -Action Find) --------
Describe 'wt-gc-junctions.ps1 CLI surface' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "wtgc-cli-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
        $script:ps1 = Join-Path $PSScriptRoot "..\lib\wt-gc-junctions.ps1"
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'REJECTS -Action Find -- the branch was unreachable and returned strings, not report objects' {
        # wt-gc.mjs only ever passes 'Remove'. Had anything routed Find through
        # its report loop, `!j.Removed` would have been truthy for every string
        # and every junction would have read as a failure.
        { & $script:ps1 -Root $script:tempDir -Action Find } | Should -Throw
    }

    It 'accepts -Action Remove and emits the {items:[...]} envelope wt-gc.mjs parses' {
        # An empty scratch root: nothing to remove, so this exercises the
        # envelope shape (never a bare array) without mutating anything.
        $json = & $script:ps1 -Root $script:tempDir -Action Remove
        $parsed = ($json | Out-String) | ConvertFrom-Json

        $parsed.PSObject.Properties.Name | Should -Contain 'items'
        @($parsed.items).Count | Should -Be 0
    }
}
