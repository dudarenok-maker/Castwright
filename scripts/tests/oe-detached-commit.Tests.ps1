#requires -Version 5.1
# Pester 5.x tests for scripts\oe-detached-commit.ps1. Invoke via
# scripts\tests\run.ps1 or `npm run test:scripts`.

BeforeAll {
    $script:scriptPath = Join-Path $PSScriptRoot '..\oe-detached-commit.ps1'
    $script:scriptText = Get-Content -Raw $script:scriptPath
}

Describe 'oe-detached-commit.ps1 static shape' {
    It 'launches the commit hidden -- the whole point of this script' {
        $script:scriptText | Should -Match '-WindowStyle\s+Hidden'
    }

    It 'takes the commit message as a bound parameter, never interpolated into a command string' {
        $script:scriptText | Should -Match '\[Parameter\(Mandatory\)\]\[string\]\$Message'
        # The child script must read the message from a file, not from a
        # string built with $Message inside it -- that reintroduces the
        # single-quote "missing terminator" bug the caller no longer has to
        # dodge.
        $script:scriptText | Should -Not -Match 'commit -m'
        $script:scriptText | Should -Match 'commit -F \(Join-Path \$Dir ''msg\.txt''\)'
    }

    It 'writes the commit message without a BOM' {
        $script:scriptText | Should -Match 'UTF8Encoding \$false'
    }

    It 'does not reference a nonexistent Delete-Item cmdlet (the real one is Remove-Item)' {
        $script:scriptText | Should -Not -Match 'Delete-Item'
    }
}

Describe 'oe-detached-commit.ps1 functional smoke test' {
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

    It 'commits detached and the commit lands with the exact message, apostrophe included' {
        $message = "test: verify detached commit don't drop quoting"
        $scratchDir = & $script:scriptPath -Worktree $script:repoDir -Message $message

        $deadline = (Get-Date).AddSeconds(30)
        $pidPath = Join-Path $scratchDir 'commit.pid'
        $logPath = Join-Path $scratchDir 'commit.log'
        do {
            Start-Sleep -Milliseconds 200
            $procId = Get-Content $pidPath -ErrorAction SilentlyContinue
            $alive = $procId -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)
            $done = (Test-Path $logPath) -and (Select-String -Path $logPath -Pattern '^EXIT=' -Quiet)
        } while ($alive -and (Get-Date) -lt $deadline)

        $done | Should -Be $true
        (Get-Content $logPath -Raw) | Should -Match 'EXIT=0'

        $landedMessage = git -C $script:repoDir log -1 --format=%s
        $landedMessage | Should -Be $message
    }
}
