#requires -Version 5.1
# Pester 5.x tests for scripts\lib\cast-reconcile.psm1. Invoke via
# scripts\tests\run.ps1 or `npm run test:scripts`.

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot "..\lib\cast-reconcile.psm1"
    Import-Module $modulePath -Force
}

Describe 'Get-CastReconciliationSummary' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "castreconcile-$([Guid]::NewGuid())"
        $script:audiobookDir = Join-Path $script:tempDir '.audiobook'
        New-Item -ItemType Directory -Path $script:audiobookDir -Force | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'returns null fields and zero counts when no .audiobook files exist' {
        $summary = Get-CastReconciliationSummary -BookDir $script:tempDir
        $summary.BookId | Should -BeNullOrEmpty
        $summary.CastCharacterCount | Should -Be 0
        $summary.EditsSentenceCount | Should -Be 0
        $summary.OrphanCharacterIds.Count | Should -Be 0
    }

    It 'tallies cast.json characters and surfaces them as a sorted unique list' {
        $state = @{ bookId = 'b1'; manuscriptId = 'm1'; title = 'The Floodmark' } | ConvertTo-Json -Depth 5
        Set-Content -Path (Join-Path $script:audiobookDir 'state.json') -Value $state -Encoding utf8

        $cast = @{ characters = @(
            @{ id = 'narrator'; name = 'Narrator' },
            @{ id = 'wren';   name = 'Wren' },
            @{ id = 'marlow';    name = 'Marlow' }
        ) } | ConvertTo-Json -Depth 5
        Set-Content -Path (Join-Path $script:audiobookDir 'cast.json') -Value $cast -Encoding utf8

        $summary = Get-CastReconciliationSummary -BookDir $script:tempDir
        $summary.BookId | Should -Be 'b1'
        $summary.ManuscriptId | Should -Be 'm1'
        $summary.Title | Should -Be 'The Floodmark'
        $summary.CastCharacterCount | Should -Be 3
        $summary.CastCharacterIds | Should -Contain 'narrator'
        $summary.CastCharacterIds | Should -Contain 'wren'
        $summary.CastCharacterIds | Should -Contain 'marlow'
    }

    It 'identifies orphan characterIds -- sentences referencing ids absent from cast.json (The Floodmark regression)' {
        $state = @{ bookId = 'b1'; manuscriptId = 'm1'; title = 'The Floodmark' } | ConvertTo-Json -Depth 5
        Set-Content -Path (Join-Path $script:audiobookDir 'state.json') -Value $state -Encoding utf8

        # cast.json has only narrator -- the The Floodmark-style corrupted state.
        $cast = @{ characters = @(@{ id = 'narrator'; name = 'Narrator' }) } | ConvertTo-Json -Depth 5
        Set-Content -Path (Join-Path $script:audiobookDir 'cast.json') -Value $cast -Encoding utf8

        # manuscript-edits.json references 4 distinct ids -- narrator (kept) plus
        # 3 orphans that A5's wipe must surface to the user.
        $edits = @{ sentences = @(
            @{ id = 1; chapterId = 1; characterId = 'narrator'; text = 'a' },
            @{ id = 2; chapterId = 1; characterId = 'marlow';    text = 'b' },
            @{ id = 3; chapterId = 2; characterId = 'oduvan';    text = 'c' },
            @{ id = 4; chapterId = 2; characterId = 'wren';   text = 'd' }
        ) } | ConvertTo-Json -Depth 5
        Set-Content -Path (Join-Path $script:audiobookDir 'manuscript-edits.json') -Value $edits -Encoding utf8

        $summary = Get-CastReconciliationSummary -BookDir $script:tempDir
        $summary.EditsSentenceCount | Should -Be 4
        @($summary.EditsCharacterIds).Count | Should -Be 4
        @($summary.OrphanCharacterIds).Count | Should -Be 3
        $summary.OrphanCharacterIds | Should -Contain 'marlow'
        $summary.OrphanCharacterIds | Should -Contain 'oduvan'
        $summary.OrphanCharacterIds | Should -Contain 'wren'
        $summary.OrphanCharacterIds | Should -Not -Contain 'narrator'
    }

    It 'tolerates malformed JSON without throwing -- leaves counts at zero' {
        Set-Content -Path (Join-Path $script:audiobookDir 'state.json') -Value 'this is not json' -Encoding utf8
        Set-Content -Path (Join-Path $script:audiobookDir 'cast.json')  -Value '{ broken'        -Encoding utf8

        $summary = Get-CastReconciliationSummary -BookDir $script:tempDir
        $summary.BookId | Should -BeNullOrEmpty
        $summary.CastCharacterCount | Should -Be 0
    }
}

Describe 'Invoke-CastReconciliation' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "castreconcile-$([Guid]::NewGuid())"
        $script:audiobookDir = Join-Path $script:tempDir '.audiobook'
        $script:cacheRoot = Join-Path $script:tempDir 'cache'
        New-Item -ItemType Directory -Path $script:audiobookDir -Force | Out-Null
        New-Item -ItemType Directory -Path $script:cacheRoot    -Force | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'archives cast.json + manuscript-edits.json to .audiobook/.reconcile-backup-<ts>/ and removes the originals' {
        Set-Content -Path (Join-Path $script:audiobookDir 'state.json')             -Value '{}' -Encoding utf8
        Set-Content -Path (Join-Path $script:audiobookDir 'cast.json')              -Value '{"characters":[{"id":"narrator","name":"Narrator"}]}' -Encoding utf8
        Set-Content -Path (Join-Path $script:audiobookDir 'manuscript-edits.json')  -Value '{"sentences":[]}' -Encoding utf8

        $result = Invoke-CastReconciliation -BookDir $script:tempDir

        # Originals gone.
        Test-Path (Join-Path $script:audiobookDir 'cast.json')             | Should -BeFalse
        Test-Path (Join-Path $script:audiobookDir 'manuscript-edits.json') | Should -BeFalse
        # state.json preserved -- it carries the bookId + manuscriptId the
        # next analysis run needs.
        Test-Path (Join-Path $script:audiobookDir 'state.json')            | Should -BeTrue

        # Backup directory exists with the right naming + contents.
        Test-Path $result.BackupDir | Should -BeTrue
        (Split-Path -Leaf $result.BackupDir) | Should -Match '^\.reconcile-backup-\d{8}-\d{6}$'
        Test-Path (Join-Path $result.BackupDir 'cast.json')             | Should -BeTrue
        Test-Path (Join-Path $result.BackupDir 'manuscript-edits.json') | Should -BeTrue
        $result.MovedFiles | Should -Contain 'cast.json'
        $result.MovedFiles | Should -Contain 'manuscript-edits.json'
    }

    It 'archives the analysis-cache entry when ManuscriptId + CacheRoot are supplied' {
        Set-Content -Path (Join-Path $script:audiobookDir 'cast.json')             -Value '{"characters":[]}' -Encoding utf8
        $cachePath = Join-Path $script:cacheRoot 'mns_xyz.json'
        Set-Content -Path $cachePath -Value '{"stage1":{"characters":[]}}' -Encoding utf8

        $result = Invoke-CastReconciliation `
            -BookDir $script:tempDir `
            -ManuscriptId 'mns_xyz' `
            -CacheRoot $script:cacheRoot

        Test-Path $cachePath | Should -BeFalse
        Test-Path (Join-Path $result.BackupDir 'cache-mns_xyz.json') | Should -BeTrue
        $result.MovedFiles | Should -Contain 'cache/mns_xyz.json'
    }

    It 'is idempotent on missing files -- runs cleanly when cast.json + edits + cache are already absent' {
        # state.json exists, the other targets do not. The reconcile must
        # not throw; it produces an empty MovedFiles list.
        Set-Content -Path (Join-Path $script:audiobookDir 'state.json') -Value '{}' -Encoding utf8

        $result = Invoke-CastReconciliation -BookDir $script:tempDir
        @($result.MovedFiles).Count | Should -Be 0
        # Empty backup dir still got created -- caller can inspect it.
        Test-Path $result.BackupDir | Should -BeTrue
    }

    It 'throws when .audiobook/ does not exist (caller passed a non-book directory)' {
        $bogusDir = Join-Path ([System.IO.Path]::GetTempPath()) "castreconcile-bogus-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $bogusDir | Out-Null
        try {
            { Invoke-CastReconciliation -BookDir $bogusDir } | Should -Throw
        } finally {
            Remove-Item $bogusDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
