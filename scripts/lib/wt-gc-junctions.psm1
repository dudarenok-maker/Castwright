#requires -Version 5.1
# Junction-first teardown primitives for scripts/wt-gc.mjs (#3051, ops-75
# Part 4). Extracted into a module so Pester can exercise the detection/
# removal logic directly, the same way scripts/lib/log-utils.psm1 does for
# the start/stop scripts.
#
# Why this exists as its own file, and why the gate is written the way it
# is: CLAUDE.md's "Worktree teardown" section and issue #3051 both record a
# near-miss where 12 of 14 worktree junctions pointed at the PRIMARY
# checkout's real node_modules/.venv/Kokoro weights. `Remove-Item -Recurse`
# over a tree that still holds one of those follows the link and deletes the
# real target — junctions must be unlinked FIRST, one at a time, via
# `[System.IO.Directory]::Delete($Path, $false)` (the `$false` is load-
# bearing: it refuses to recurse, so it can only ever unlink the reparse
# point itself, never walk into — and delete — what it points at).
#
# The detection gate is the ReparsePoint attribute bit, NEVER `.LinkTarget`:
# `.LinkTarget` is a .NET 6+ property that PowerShell 7.2+ (built on modern
# .NET) exposes, but Windows PowerShell 5.1 (built on .NET Framework) does
# not — on THIS box it reads back empty even for a real junction, so a guard
# written against it silently evaluates false and skips the delete, letting
# a later recursive remove follow the link. `.Attributes -band
# [IO.FileAttributes]::ReparsePoint` works identically on both engines.
# `.Target` (a PowerShell-provider-added property, not `.LinkTarget`) is safe
# to use for reporting only — it is never load-bearing for detection here.

# True when the given filesystem item is a reparse point (junction or
# directory symlink) — the ONLY gate this module uses to decide "is this a
# link, or a real directory". Never touches `.LinkTarget`.
function Test-IsReparsePoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [System.IO.FileSystemInfo] $Item
    )
    return [bool]($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# Recursively enumerate reparse-point directories under $Root. Deliberately
# does NOT descend into a reparse point once found — its contents live at
# whatever it points to, not under $Root, so walking into it would either
# re-discover the same junctions from a different path or (worse, for a
# junction pointing at a live checkout) enumerate a real, unrelated tree.
# Returns an array (always — even for 0 or 1 matches, via the unary `,`
# comma operator, which PowerShell would otherwise unwrap to a bare string).
function Get-JunctionsRecursive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Root
    )
    $found = New-Object System.Collections.Generic.List[string]
    if (-not (Test-Path -LiteralPath $Root)) {
        return , @()
    }

    function Test-JunctionsWalk {
        param([string] $Dir)
        $item = $null
        try {
            $item = Get-Item -LiteralPath $Dir -Force -ErrorAction Stop
        } catch {
            return
        }
        if (Test-IsReparsePoint -Item $item) {
            $found.Add($Dir)
            return
        }
        Get-ChildItem -LiteralPath $Dir -Directory -Force -ErrorAction SilentlyContinue |
            ForEach-Object { Test-JunctionsWalk -Dir $_.FullName }
    }

    Test-JunctionsWalk -Dir $Root
    return , @($found.ToArray())
}

# Unlink every reparse-point directory found under $Root, junction-first,
# one at a time, and report the outcome of each. Never touches a matched
# item's TARGET — `[System.IO.Directory]::Delete($Path, $false)` refuses to
# recurse, so it can only remove the link itself. Verification is by
# Test-Path on both the link and (when resolvable) its target, never by
# trusting a non-throwing call as proof — `cmd /c rmdir` from a bash shell is
# on record silently no-op'ing and returning 0, so this module never assumes
# success from the absence of an exception alone.
function Remove-JunctionsRecursive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Root
    )
    $junctions = Get-JunctionsRecursive -Root $Root
    $results = foreach ($path in $junctions) {
        $target = $null
        try {
            $target = (Get-Item -LiteralPath $path -Force -ErrorAction Stop).Target
        } catch {
            $target = $null
        }
        $targetPath = $null
        if ($target) {
            $targetPath = if ($target -is [array]) { $target[0] } else { $target }
        }

        try {
            [System.IO.Directory]::Delete($path, $false)
            $stillThere = Test-Path -LiteralPath $path
            $targetStillExists = $null
            if ($targetPath) { $targetStillExists = Test-Path -LiteralPath $targetPath }
            [PSCustomObject]@{
                Path              = $path
                Target            = $targetPath
                Removed           = (-not $stillThere)
                TargetStillExists = $targetStillExists
                Error             = $null
            }
        } catch {
            [PSCustomObject]@{
                Path              = $path
                Target            = $targetPath
                Removed           = $false
                TargetStillExists = $null
                Error             = $_.Exception.Message
            }
        }
    }
    return , @($results)
}

Export-ModuleMember -Function Test-IsReparsePoint, Get-JunctionsRecursive, Remove-JunctionsRecursive
