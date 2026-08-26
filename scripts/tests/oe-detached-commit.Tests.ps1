#requires -Version 5.1
# Pester 5.x tests for scripts\oe-detached-commit.ps1. Invoke via
# scripts\tests\run.ps1 or `npm run test:scripts`.
#
# The static checks below parse the script's AST rather than grepping its
# text: a naive `Should -Match '-WindowStyle\s+Hidden'` against the whole
# file also matches the docstring and an explanatory comment, so it stays
# green even if the real Start-Process call is edited to drop the flag (this
# happened during review of PR #2662 -- a mutation that deleted the flag
# from the live call passed the whole-file-grep version of this test).
# Matching against the parsed CommandAst only sees executable code: comments
# and the comment-based help block are not part of the AST at all.

BeforeAll {
    $script:scriptPath = Join-Path $PSScriptRoot '..\oe-detached-commit.ps1'
    $script:scriptText = Get-Content -Raw $script:scriptPath

    $tokens = $null
    $errors = $null
    $script:ast = [System.Management.Automation.Language.Parser]::ParseFile($script:scriptPath, [ref]$tokens, [ref]$errors)

    $script:startProcessCalls = $script:ast.FindAll(
        { param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Start-Process' },
        $true)

    $script:childScriptAssignment = $script:ast.FindAll(
        {
            param($node)
            $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $node.Left.VariablePath.UserPath -eq 'childScript'
        },
        $true) | Select-Object -First 1
}

Describe 'oe-detached-commit.ps1 static shape (AST-based, comment/docstring-proof)' {
    It 'parses without errors' {
        $script:ast | Should -Not -BeNullOrEmpty
    }

    It 'calls Start-Process exactly once, to launch the commit' {
        $script:startProcessCalls.Count | Should -Be 1
    }

    It 'launches the commit hidden -- the whole point of this script' {
        $call = $script:startProcessCalls[0]
        $elements = $call.CommandElements
        $windowStyleIndex = -1
        for ($i = 0; $i -lt $elements.Count; $i++) {
            if ($elements[$i] -is [System.Management.Automation.Language.CommandParameterAst] -and
                $elements[$i].ParameterName -eq 'WindowStyle') {
                $windowStyleIndex = $i
                break
            }
        }
        $windowStyleIndex | Should -BeGreaterThan -1 -Because 'a -WindowStyle parameter must be bound on the real Start-Process call, not just mentioned in a comment'
        $elements[$windowStyleIndex + 1].Extent.Text | Should -Be 'Hidden'
    }

    It 'takes the commit message as a bound parameter, never interpolated into a command string' {
        $script:childScriptAssignment | Should -Not -BeNullOrEmpty
        $childScriptValue = $script:childScriptAssignment.Right.Expression.Value
        $childScriptValue | Should -Not -BeNullOrEmpty
        $childScriptValue | Should -Not -Match 'commit -m'
        $childScriptValue | Should -Match 'commit -F \(Join-Path \$Dir ''msg\.txt''\)'
    }

    It 'writes the commit message without a BOM' {
        $writeAllTextCalls = $script:ast.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
                $node.Member.Value -eq 'WriteAllText'
            },
            $true)
        $writeAllTextCalls.Count | Should -Be 1 -Because 'exactly one WriteAllText call should write msg.txt'
        # The 3rd argument is the encoding; must be UTF8Encoding constructed with $false (no BOM), not just
        # mentioned somewhere else in the file.
        $writeAllTextCalls[0].Arguments[2].Extent.Text | Should -Match 'UTF8Encoding.*\$false'
    }

    It 'does not reference a nonexistent Delete-Item cmdlet (the real one is Remove-Item)' {
        $script:scriptText | Should -Not -Match 'Delete-Item'
    }

    It 'strips a trailing backslash from -Worktree before it can escape a closing quote' {
        $script:scriptText | Should -Match ([regex]::Escape('$Worktree = $Worktree.TrimEnd(''\'')'))
    }

    It 'gives every scratch directory a per-call GUID component, not just a per-second timestamp' {
        $script:scriptText | Should -Match '\[Guid\]::NewGuid\(\)'
    }
}

Describe 'oe-detached-commit.ps1 functional smoke tests' -Skip:($env:OS -ne 'Windows_NT') {
    # Start-Process launches a `powershell` binary that only exists on
    # Windows; `npm run verify`'s Linux CI runner has no target for it. These
    # tests are a no-op there rather than a false failure, matching the
    # Windows-only pattern already used by prevent-sleep.Tests.ps1.

    BeforeEach {
        $script:repoDir = Join-Path ([System.IO.Path]::GetTempPath()) "oe-commit-test-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:repoDir -Force | Out-Null
        git -C $script:repoDir init --quiet
        git -C $script:repoDir config user.email 'test@example.com'
        git -C $script:repoDir config user.name 'Test'
        Set-Content -Path (Join-Path $script:repoDir 'file.txt') -Value 'hello' -Encoding utf8
        git -C $script:repoDir add file.txt
    }

    AfterEach {
        if (Test-Path $script:repoDir) {
            Remove-Item $script:repoDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    BeforeAll {
        # Defined in BeforeAll (not loose in the Describe body) so it is
        # visible to every It block's own scope -- Pester 5 does not share
        # a plain `function` statement dropped directly in a Describe body.
        function Wait-ForDetachedCommit([string]$ScratchDir, [int]$TimeoutSeconds = 30) {
            $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
            $pidPath = Join-Path $ScratchDir 'commit.pid'
            $logPath = Join-Path $ScratchDir 'commit.log'
            do {
                Start-Sleep -Milliseconds 200
                $procId = Get-Content $pidPath -ErrorAction SilentlyContinue
                $alive = $procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)
                $done = (Test-Path $logPath) -and (Select-String -Path $logPath -Pattern '^EXIT=' -Quiet)
            } while ($alive -and (Get-Date) -lt $deadline)
            return $logPath
        }
    }

    It 'commits detached and the commit lands with the exact message, apostrophe included' {
        $message = "test: verify detached commit don't drop quoting"
        $scratchDir = & $script:scriptPath -Worktree $script:repoDir -Message $message
        $logPath = Wait-ForDetachedCommit -ScratchDir $scratchDir

        (Get-Content $logPath -Raw) | Should -Match 'EXIT=0'
        (git -C $script:repoDir log -1 --format=%s) | Should -Be $message
    }

    It 'tolerates a trailing backslash on -Worktree instead of swallowing the rest of the command line' {
        $worktreeWithTrailingSlash = $script:repoDir + '\'
        $message = 'test: trailing backslash on worktree path'
        $scratchDir = & $script:scriptPath -Worktree $worktreeWithTrailingSlash -Message $message
        $logPath = Wait-ForDetachedCommit -ScratchDir $scratchDir

        (Get-Content $logPath -Raw) | Should -Match 'EXIT=0'
        (git -C $script:repoDir log -1 --format=%s) | Should -Be $message
    }

    It 'gives two same-second launches independent scratch directories, so neither commit is misattributed to the other' {
        $repoA = $script:repoDir
        $repoB = Join-Path ([System.IO.Path]::GetTempPath()) "oe-commit-test-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $repoB -Force | Out-Null
        git -C $repoB init --quiet
        git -C $repoB config user.email 'test@example.com'
        git -C $repoB config user.name 'Test'
        Set-Content -Path (Join-Path $repoB 'file.txt') -Value 'hello' -Encoding utf8
        git -C $repoB add file.txt

        try {
            $scratchA = & $script:scriptPath -Worktree $repoA -Message 'test: lane A commit'
            $scratchB = & $script:scriptPath -Worktree $repoB -Message 'test: lane B commit'

            $scratchA | Should -Not -Be $scratchB

            Wait-ForDetachedCommit -ScratchDir $scratchA | Out-Null
            Wait-ForDetachedCommit -ScratchDir $scratchB | Out-Null

            (git -C $repoA log -1 --format=%s) | Should -Be 'test: lane A commit'
            (git -C $repoB log -1 --format=%s) | Should -Be 'test: lane B commit'
        } finally {
            Remove-Item $repoB -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
