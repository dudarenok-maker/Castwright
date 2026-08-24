#requires -Version 5.1
# Pester 5.x tests for scripts\lib\log-utils.psm1. Invoke via scripts\tests\run.ps1.

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot "..\lib\log-utils.psm1"
    Import-Module $modulePath -Force
}

Describe 'New-FreshLog' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "freshlog-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'truncates an existing writable file and returns the same path' {
        $path = Join-Path $script:tempDir "x.log"
        Set-Content -Path $path -Value "old content" -Encoding utf8

        $result = New-FreshLog -Path $path

        $result | Should -Be $path
        # Windows PowerShell's Set-Content -Encoding utf8 writes a BOM + CRLF,
        # so byte-length 0 isn't reachable. The contract we actually care about
        # is that the previous content is gone.
        (Get-Content $path -Raw) | Should -Not -Match 'old content'
    }

    It 'creates a new file when the path does not yet exist' {
        $path = Join-Path $script:tempDir "new.log"

        $result = New-FreshLog -Path $path

        $result | Should -Be $path
        Test-Path $path | Should -BeTrue
    }

    It 'rotates to a timestamped sibling when the canonical file is locked' {
        $path = Join-Path $script:tempDir "locked.log"
        Set-Content -Path $path -Value "stuck content" -Encoding utf8

        # Exclusive lock: deny all sharing so Set-Content cannot truncate.
        $fs = [System.IO.File]::Open($path, 'Open', 'Write', 'None')
        try {
            $result = New-FreshLog -Path $path

            $result | Should -Not -Be $path
            (Split-Path -Leaf $result) | Should -Match '^locked\.\d{8}-\d{6}\.log$'
            Test-Path $result | Should -BeTrue
        } finally {
            $fs.Close()
        }
    }

    It 'preserves a multi-segment basename across rotation (e.g. tts.err.log)' {
        $path = Join-Path $script:tempDir "tts.err.log"
        Set-Content -Path $path -Value "stuck" -Encoding utf8

        $fs = [System.IO.File]::Open($path, 'Open', 'Write', 'None')
        try {
            $result = New-FreshLog -Path $path

            (Split-Path -Leaf $result) | Should -Match '^tts\.err\.\d{8}-\d{6}\.log$'
        } finally {
            $fs.Close()
        }
    }
}

Describe 'Remove-OldRotatedLogs' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "rotated-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'removes timestamped logs older than MaxAgeDays' {
        $old = Join-Path $script:tempDir "tts.20260101-000000.log"
        Set-Content -Path $old -Value "" -Encoding utf8
        (Get-Item $old).LastWriteTime = (Get-Date).AddDays(-10)

        Remove-OldRotatedLogs -Dir $script:tempDir -MaxAgeDays 7

        Test-Path $old | Should -BeFalse
    }

    It 'leaves the canonical (untimestamped) log alone regardless of age' {
        $canonical = Join-Path $script:tempDir "tts.log"
        Set-Content -Path $canonical -Value "" -Encoding utf8
        (Get-Item $canonical).LastWriteTime = (Get-Date).AddDays(-365)

        Remove-OldRotatedLogs -Dir $script:tempDir -MaxAgeDays 7

        Test-Path $canonical | Should -BeTrue
    }

    It 'leaves the canonical err.log alone regardless of age' {
        $canonical = Join-Path $script:tempDir "tts.err.log"
        Set-Content -Path $canonical -Value "" -Encoding utf8
        (Get-Item $canonical).LastWriteTime = (Get-Date).AddDays(-365)

        Remove-OldRotatedLogs -Dir $script:tempDir -MaxAgeDays 7

        Test-Path $canonical | Should -BeTrue
    }

    It 'keeps timestamped logs newer than MaxAgeDays' {
        $fresh = Join-Path $script:tempDir "tts.20260513-100000.log"
        Set-Content -Path $fresh -Value "" -Encoding utf8
        (Get-Item $fresh).LastWriteTime = (Get-Date).AddDays(-1)

        Remove-OldRotatedLogs -Dir $script:tempDir -MaxAgeDays 7

        Test-Path $fresh | Should -BeTrue
    }

    It 'is a no-op when the directory does not exist' {
        $missing = Join-Path $script:tempDir "no-such-subdir"

        { Remove-OldRotatedLogs -Dir $missing -MaxAgeDays 7 } | Should -Not -Throw
    }
}

Describe 'Resolve-RunDir (#2632 N35)' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "rundir-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'defaults to <RepoRoot>\.run when APP_RUN_DIR is unset' {
        Resolve-RunDir -RepoRoot $script:tempDir | Should -Be (Join-Path $script:tempDir ".run")
    }

    It 'returns an absolute, EXISTING path unchanged' {
        $existing = Join-Path $script:tempDir "shared-run"
        New-Item -ItemType Directory -Path $existing | Out-Null

        Resolve-RunDir -RepoRoot $script:tempDir -AppRunDir $existing | Should -Be $existing
    }

    # The defect this whole finding is about: Resolve-Path returns $null
    # (silently) for a path that does not exist yet — a versioned install
    # before its first launch, or autoStartSidecar off so nothing has mkdir'd
    # .run\ yet. Resolve-RunDir must return a real, non-null lexical path
    # here, exactly like Node's path.resolve() would, or every downstream
    # consumer (Join-Path, Get-SidecarSweepPort -RunDir) fails to bind and
    # the stop script silently reports "nothing to stop".
    It 'returns a non-null lexical path for an absolute path that does NOT exist yet' {
        $nonExistent = Join-Path $script:tempDir "not-created-yet"

        $result = Resolve-RunDir -RepoRoot $script:tempDir -AppRunDir $nonExistent

        $result | Should -Not -BeNullOrEmpty
        $result | Should -Be $nonExistent
    }

    It 'never touches the filesystem for a glob-shaped path (would fail Test-Path/expand under Resolve-Path)' {
        $globPath = Join-Path $script:tempDir "run-[wt]"

        $result = Resolve-RunDir -RepoRoot $script:tempDir -AppRunDir $globPath

        $result | Should -Be $globPath
    }
}

Describe 'start-app.ps1 / stop-app.ps1 agree on $runDir (#2632 N35)' {
    # The regression this finding names: start-app.ps1 was never migrated
    # off a hardcoded <repoRoot>\.run, so with APP_RUN_DIR set the launcher
    # wrote PIDs to one directory and the stopper looked in another. Both
    # must resolve $runDir via the SAME shared helper.
    It 'both scripts assign $runDir from Resolve-RunDir' {
        $startSource = Get-Content (Join-Path $PSScriptRoot "..\start-app.ps1") -Raw
        $stopSource  = Get-Content (Join-Path $PSScriptRoot "..\stop-app.ps1") -Raw

        $startSource | Should -Match '\$runDir\s*=\s*Resolve-RunDir\b'
        $stopSource  | Should -Match '\$runDir\s*=\s*Resolve-RunDir\b'
        $startSource | Should -Not -Match '\$runDir\s*=\s*Join-Path \$repoRoot "\.run"'
    }
}
