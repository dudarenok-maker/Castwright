#requires -Version 5.1
# Reconcile a book whose .audiobook/* files have drifted out of sync with
# the analysis cache (Phase 1 sentences referencing characters that no
# longer exist in cast.json, etc.). Archives cast.json, manuscript-edits.json,
# and the analysis-cache entry to .audiobook/.reconcile-backup-<timestamp>/,
# then deletes the originals so the next analysis run starts clean.
#
# Use only after the in-route guards (A1/A2/A3) are live -- this script is
# the wipe step for books whose data drifted before those guards landed.
# Invoke via `npm run reconcile-cast -- --book-id=<id>`.
#
# Parameters:
#   -BookId         Required. The fully-slugged bookId, e.g.
#                   shannon-messenger__the-hollow-tide__unlocked
#   -WorkspaceDir   Optional override. Defaults to:
#                     1. server/user-settings.json `workspaceDirOverride`
#                     2. server/.env  WORKSPACE_DIR
#                     3. <repo>/audiobook-workspace
#   -SkipConfirm    Bypass the y/N prompt. Used by Pester tests; do not
#                   pass in production unless you really mean it.

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $BookId,
    [string] $WorkspaceDir,
    [switch] $SkipConfirm
)

$ErrorActionPreference = 'Stop'

$here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot   = Split-Path -Parent $here
$modulePath = Join-Path $here 'lib\cast-reconcile.psm1'
Import-Module $modulePath -Force

# Workspace resolution -- mirrors server/src/workspace/paths.ts precedence:
#   user-settings.json override > WORKSPACE_DIR env > built-in default.
function Resolve-WorkspaceDir {
    param([string] $Override)
    if ($Override) { return (Resolve-Path $Override).Path }

    $userSettings = Join-Path $repoRoot 'server\user-settings.json'
    if (Test-Path $userSettings) {
        try {
            $parsed = Get-Content $userSettings -Raw | ConvertFrom-Json
            if ($parsed.workspaceDirOverride) {
                return (Resolve-Path $parsed.workspaceDirOverride).Path
            }
        } catch { }
    }

    $envFile = Join-Path $repoRoot 'server\.env'
    if (Test-Path $envFile) {
        $envVal = Get-Content $envFile | Where-Object { $_ -match '^\s*WORKSPACE_DIR\s*=' }
        if ($envVal) {
            $val = ($envVal -replace '^\s*WORKSPACE_DIR\s*=\s*', '').Trim()
            if ($val) {
                # Resolve relative paths against server/ to match the server's own logic.
                if (-not (Split-Path $val -IsAbsolute)) {
                    $val = Join-Path (Join-Path $repoRoot 'server') $val
                }
                return (Resolve-Path $val).Path
            }
        }
    }

    return (Resolve-Path (Join-Path $repoRoot 'audiobook-workspace')).Path
}

function Find-BookDir {
    param(
        [Parameter(Mandatory)] [string] $WorkspaceRoot,
        [Parameter(Mandatory)] [string] $TargetBookId
    )
    $booksRoot = Join-Path $WorkspaceRoot 'books'
    if (-not (Test-Path $booksRoot)) {
        throw "No books/ directory under workspace '$WorkspaceRoot'."
    }
    foreach ($author in Get-ChildItem -Path $booksRoot -Directory -ErrorAction SilentlyContinue) {
        foreach ($series in Get-ChildItem -Path $author.FullName -Directory -ErrorAction SilentlyContinue) {
            foreach ($title in Get-ChildItem -Path $series.FullName -Directory -ErrorAction SilentlyContinue) {
                $statePath = Join-Path $title.FullName '.audiobook\state.json'
                if (-not (Test-Path $statePath)) { continue }
                try {
                    $state = Get-Content $statePath -Raw | ConvertFrom-Json
                    if ($state.bookId -eq $TargetBookId) {
                        return $title.FullName
                    }
                } catch { }
            }
        }
    }
    return $null
}

$workspaceRoot = Resolve-WorkspaceDir -Override $WorkspaceDir
Write-Host "Workspace: $workspaceRoot"

$bookDir = Find-BookDir -WorkspaceRoot $workspaceRoot -TargetBookId $BookId
if (-not $bookDir) {
    Write-Host "No book found with bookId '$BookId'." -ForegroundColor Red
    exit 1
}
Write-Host "Book directory: $bookDir"

$summary = Get-CastReconciliationSummary -BookDir $bookDir
Write-Host ""
Write-Host "Current on-disk state:"
Write-Host ("  Title:                {0}" -f $summary.Title)
Write-Host ("  manuscriptId:         {0}" -f $summary.ManuscriptId)
Write-Host ("  cast.json characters: {0}" -f $summary.CastCharacterCount)
if ($summary.CastCharacterIds.Count -gt 0) {
    Write-Host ("    ({0})" -f ($summary.CastCharacterIds -join ', '))
}
Write-Host ("  manuscript-edits.json sentences: {0}" -f $summary.EditsSentenceCount)
if ($summary.EditsCharacterIds.Count -gt 0) {
    Write-Host ("    characterIds: {0}" -f ($summary.EditsCharacterIds -join ', '))
}
if ($summary.OrphanCharacterIds.Count -gt 0) {
    Write-Host ("  Orphan IDs (in sentences but not cast.json): {0}" -f ($summary.OrphanCharacterIds -join ', ')) -ForegroundColor Yellow
}

$cacheRoot = Join-Path $repoRoot 'server\handoff\cache'
Write-Host ""
Write-Host "Reconciliation will:"
Write-Host "  - Archive cast.json + manuscript-edits.json to .audiobook/.reconcile-backup-<timestamp>/"
if ($summary.ManuscriptId -and (Test-Path (Join-Path $cacheRoot ($summary.ManuscriptId + '.json')))) {
    Write-Host "  - Archive the analysis-cache entry for $($summary.ManuscriptId) into the same backup"
}
Write-Host "  - Leave state.json + change-log.json + dropped-quotes.json alone"
Write-Host "  - Require a fresh analysis run to repopulate the cast"
Write-Host ""

if (-not $SkipConfirm) {
    $answer = Read-Host "Proceed? (y/N)"
    if ($answer -notmatch '^[Yy]') {
        Write-Host "Aborted." -ForegroundColor Yellow
        exit 0
    }
}

$result = Invoke-CastReconciliation `
    -BookDir $bookDir `
    -ManuscriptId $summary.ManuscriptId `
    -CacheRoot $cacheRoot

Write-Host ""
Write-Host "Reconciliation complete." -ForegroundColor Green
Write-Host ("Backup:       {0}" -f $result.BackupDir)
Write-Host ("Moved files:  {0}" -f ($result.MovedFiles -join ', '))
Write-Host ""
Write-Host "Next: re-run analysis on this book to repopulate cast.json + manuscript-edits.json."
