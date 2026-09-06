#requires -Version 5.1
# Pester 5.x tests for scripts\lib\wt-gc-junctions.psm1. Invoke via
# scripts\tests\run.ps1 (npm run test:scripts).
#
# Covers: junction detection is gated on the ReparsePoint attribute (never
# `.LinkTarget`, source-pinned below); recursion never descends INTO a found
# junction; removal unlinks the junction but leaves its target's own content
# untouched; removal is verified by Test-Path, not by "the call didn't
# throw".

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

    It 'never gates on .LinkTarget in code — reads empty on this box''s Windows PowerShell 5.1 even for a real junction' {
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
