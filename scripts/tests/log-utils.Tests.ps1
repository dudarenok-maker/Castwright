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
