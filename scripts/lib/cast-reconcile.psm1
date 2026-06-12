#requires -Version 5.1
# Helpers for reconciling a book whose .audiobook/* files have drifted out
# of sync with the analysis cache (Phase 1 sentences referencing characters
# that no longer exist in cast.json, etc.). Extracted into a module so
# Pester can exercise the archive/remove machinery without a real workspace.
#
# Motivating regression: "The Floodmark" (mns_VoP0mLGvov) -- cast.json had 1
# character (Narrator), manuscript-edits.json had 4192 sentences across
# 6 distinct characterIds, the analysis cache held a Narrator-only stage1
# over a sparse chapterCast. The path forward there was to wipe + re-run
# after the A1-A4 fixes landed; this module is the wipe step.

function Get-CastReconciliationSummary {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $BookDir
    )
    $audiobookDir = Join-Path $BookDir '.audiobook'
    $statePath = Join-Path $audiobookDir 'state.json'
    $castPath  = Join-Path $audiobookDir 'cast.json'
    $editsPath = Join-Path $audiobookDir 'manuscript-edits.json'

    $result = [ordered]@{
        BookDir            = $BookDir
        StatePath          = $statePath
        CastPath           = $castPath
        EditsPath          = $editsPath
        BookId             = $null
        ManuscriptId       = $null
        Title              = $null
        CastCharacterCount = 0
        CastCharacterIds   = @()
        EditsSentenceCount = 0
        EditsCharacterIds  = @()
        OrphanCharacterIds = @()
    }

    if (Test-Path $statePath) {
        try {
            $state = Get-Content $statePath -Raw | ConvertFrom-Json
            $result.BookId       = $state.bookId
            $result.ManuscriptId = $state.manuscriptId
            $result.Title        = $state.title
        } catch {
            # Malformed state.json -- leave fields as $null so the caller
            # can surface a useful error instead of bombing here.
        }
    }

    if (Test-Path $castPath) {
        try {
            $cast = Get-Content $castPath -Raw | ConvertFrom-Json
            if ($cast.characters) {
                $result.CastCharacterCount = @($cast.characters).Count
                $result.CastCharacterIds   = @($cast.characters | ForEach-Object { $_.id })
            }
        } catch { }
    }

    if (Test-Path $editsPath) {
        try {
            $edits = Get-Content $editsPath -Raw | ConvertFrom-Json
            if ($edits.sentences) {
                $sentences = @($edits.sentences)
                $result.EditsSentenceCount = $sentences.Count
                $result.EditsCharacterIds  = @($sentences | ForEach-Object { $_.characterId } | Sort-Object -Unique)
            }
        } catch { }
    }

    # An orphan id is referenced by Phase 1 sentences but missing from
    # cast.json -- exactly the residue A2's validator now prevents going
    # forward, and the reason we have an A5 reconcile step for books
    # whose data drifted before A2 landed.
    if ($result.EditsCharacterIds.Count -gt 0 -and $result.CastCharacterIds.Count -gt 0) {
        $castSet = @{}
        foreach ($id in $result.CastCharacterIds) { $castSet[$id] = $true }
        $result.OrphanCharacterIds = @(
            $result.EditsCharacterIds | Where-Object { -not $castSet.ContainsKey($_) }
        )
    }

    return [pscustomobject]$result
}

# Archive cast.json + manuscript-edits.json + the analysis-cache entry to
# `.audiobook/.reconcile-backup-<timestamp>/`, then delete the originals.
# Idempotent on missing files: archives whichever subset exists, no-ops on
# the rest. Returns the backup directory path so the caller can surface it
# to the user.
function Invoke-CastReconciliation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [string] $BookDir,
        # Optional -- when provided, the cache entry at
        # `<repo>/server/handoff/cache/<ManuscriptId>.json` is archived
        # too. Without it the cache stays put (caller may not know the
        # manuscriptId, or may be running against a non-workspace book).
        [string] $ManuscriptId,
        [string] $CacheRoot
    )

    $audiobookDir = Join-Path $BookDir '.audiobook'
    if (-not (Test-Path $audiobookDir)) {
        throw "No .audiobook/ directory under '$BookDir' -- nothing to reconcile."
    }

    $stamp     = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $backupDir = Join-Path $audiobookDir ".reconcile-backup-$stamp"
    New-Item -ItemType Directory -Path $backupDir | Out-Null

    $movedFiles = @()
    foreach ($name in @('cast.json', 'manuscript-edits.json')) {
        $src = Join-Path $audiobookDir $name
        if (Test-Path $src) {
            $dst = Join-Path $backupDir $name
            Move-Item -Path $src -Destination $dst
            $movedFiles += $name
        }
    }

    if ($ManuscriptId -and $CacheRoot) {
        $cachePath = Join-Path $CacheRoot "$ManuscriptId.json"
        if (Test-Path $cachePath) {
            $dst = Join-Path $backupDir "cache-$ManuscriptId.json"
            Move-Item -Path $cachePath -Destination $dst
            $movedFiles += "cache/$ManuscriptId.json"
        }
    }

    return [pscustomobject]@{
        BackupDir  = $backupDir
        MovedFiles = $movedFiles
    }
}

Export-ModuleMember -Function Get-CastReconciliationSummary, Invoke-CastReconciliation
