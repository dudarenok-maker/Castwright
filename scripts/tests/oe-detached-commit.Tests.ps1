#requires -Version 5.1
# Pester 5.x tests for scripts\oe-detached-commit.ps1. Invoke via
# scripts\tests\run.ps1 or `npm run test:scripts`.
#
# Most static checks below parse the script's AST rather than grepping its
# text: a naive `Should -Match '-WindowStyle\s+Hidden'` against the whole
# file also matches the docstring and an explanatory comment, so it stays
# green even if the real Start-Process call is edited to drop the flag (this
# happened during review of PR #2662 -- a mutation that deleted the flag
# from the live call passed the whole-file-grep version of this test, and a
# later round found the fix had reintroduced the same blind spot for two
# more assertions before those were AST-ified too). Matching against the
# parsed CommandAst only sees executable code: comments and the comment-
# based help block are not part of the AST at all.
#
# One exception, by design: the "no Delete-Item" check further down IS a
# whole-file text match. It is a NEGATIVE assertion (asserts an absence, not
# a presence), so the blind spot above cannot make it falsely pass -- at
# worst a comment mentioning the word turns it red on a change that made no
# real difference, never green over a real regression. Cataloguing every
# spelling of a hallucinated cmdlet name via AST would cost more than the
# false-red risk it avoids.

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

    $script:worktreeTrimAssignment = $script:ast.FindAll(
        {
            param($node)
            $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $node.Left.VariablePath.UserPath -eq 'Worktree' -and
            $node.Right.Expression -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
            $node.Right.Expression.Member.Value -eq 'TrimEnd' -and
            $node.Right.Expression.Expression -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $node.Right.Expression.Expression.VariablePath.UserPath -eq 'Worktree'
        },
        $true) | Select-Object -First 1

    $script:scratchDirAssignment = $script:ast.FindAll(
        {
            param($node)
            $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
            $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
            $node.Left.VariablePath.UserPath -eq 'T'
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
        $windowStyleParam = $elements[$windowStyleIndex]
        # Accept -WindowStyle Hidden (separate token), -WindowStyle:Hidden
        # (bound directly on the parameter AST via colon syntax), and a
        # quoted 'Hidden' -- all three are the same real flag, and a false
        # red on the colon/quoted forms would be its own bug in this guard.
        $value = if ($windowStyleParam.Argument) {
            $windowStyleParam.Argument.Extent.Text.Trim("'`"")
        } else {
            $elements[$windowStyleIndex + 1].Extent.Text.Trim("'`"")
        }
        $value | Should -Be 'Hidden'
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
        # AST-based, not a whole-file grep: a text match against
        # '$Worktree.TrimEnd(''\'')' stays green even if the line is
        # commented out (this happened during review -- pass 2 on #2662
        # found the pass-1 fix had reintroduced the exact blind spot it had
        # just closed, for its own two new assertions).
        $script:worktreeTrimAssignment | Should -Not -BeNullOrEmpty -Because '$Worktree = $Worktree.TrimEnd(...) must be a real, executed assignment'
        $trimArgs = $script:worktreeTrimAssignment.Right.Expression.Arguments
        $trimArgs.Count | Should -Be 1
        $trimArgs[0].Value | Should -Be '\'
    }

    It 'gives every scratch directory a per-call GUID component, not just a per-second timestamp' {
        $script:scratchDirAssignment | Should -Not -BeNullOrEmpty -Because 'the scratch directory ($T) must be assigned somewhere'
        $guidCalls = $script:scratchDirAssignment.FindAll(
            {
                param($node)
                $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
                $node.Member.Value -eq 'NewGuid' -and
                $node.Static
            },
            $true)
        $guidCalls.Count | Should -BeGreaterThan 0 -Because '[Guid]::NewGuid() must be part of the actual $T assignment, not just present elsewhere in the file'
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
        $script:scratchDirs = @()
    }

    AfterEach {
        if (Test-Path $script:repoDir) {
            Remove-Item $script:repoDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        foreach ($dir in $script:scratchDirs) {
            if (Test-Path $dir) {
                Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
        $script:scratchDirs = @()
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
            } while ($alive -and (Get-Date) -lt $deadline)
            return $logPath
        }

        # Every It below launches the real script, which creates a fresh
        # %TEMP%\cw-commit-* scratch dir it never cleans up itself (by
        # design -- the caller polls it after the process exits). Track
        # each one so the test suite doesn't leak them into %TEMP% run
        # after run (79 had accumulated there before this fix).
        function Register-ScratchDir([string]$Dir) {
            $script:scratchDirs += $Dir
            return $Dir
        }
    }

    It 'commits detached and the commit lands with the exact message, apostrophe included' {
        $message = "test: verify detached commit don't drop quoting"
        $scratchDir = Register-ScratchDir (& $script:scriptPath -Worktree $script:repoDir -Message $message)
        $logPath = Wait-ForDetachedCommit -ScratchDir $scratchDir

        (Get-Content $logPath -Raw) | Should -Match 'EXIT=0'
        (git -C $script:repoDir log -1 --format=%s) | Should -Be $message
    }

    It 'tolerates a trailing backslash on -Worktree instead of swallowing the rest of the command line' {
        $worktreeWithTrailingSlash = $script:repoDir + '\'
        $message = 'test: trailing backslash on worktree path'
        $scratchDir = Register-ScratchDir (& $script:scriptPath -Worktree $worktreeWithTrailingSlash -Message $message)
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
            $scratchA = Register-ScratchDir (& $script:scriptPath -Worktree $repoA -Message 'test: lane A commit')
            $scratchB = Register-ScratchDir (& $script:scriptPath -Worktree $repoB -Message 'test: lane B commit')

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
