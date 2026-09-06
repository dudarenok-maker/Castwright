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
#
# FAILS CLOSED: every enumeration error THROWS rather than being swallowed.
# This used to be `-ErrorAction SilentlyContinue` on the Get-ChildItem and a
# bare `catch { return }` on the Get-Item, which dropped whole subtrees
# without a signal — and an empty result that means "the scan FAILED" is
# indistinguishable from one that means "there are no junctions here". The
# caller (scripts/wt-gc.mjs) acts on that emptiness by running
# `git worktree remove --force`, which then follows the junction the scan
# never saw into the primary checkout's real node_modules/.venv. Measured
# shape: a junction at a 394-character path is found by `pwsh`, while
# Windows PowerShell 5.1 raises PathTooLongException inside Get-ChildItem
# and — with SilentlyContinue — answered `{"items": []}`, exit 0, no
# warning. wt-gc.mjs's pickPowerShell() falls back to `powershell`, and this
# module declares `#requires -Version 5.1`, so that engine is supported, not
# hypothetical. An ACL-denied directory swallows identically on both
# engines. A partial scan is never reported as a complete one.
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
            throw "wt-gc: junction scan could not inspect '$Dir' -- the scan is INCOMPLETE and must not be treated as 'no junctions found': $($_.Exception.Message)"
        }
        if (Test-IsReparsePoint -Item $item) {
            $found.Add($Dir)
            return
        }
        $children = @()
        try {
            $children = @(Get-ChildItem -LiteralPath $Dir -Directory -Force -ErrorAction Stop)
        } catch {
            throw "wt-gc: junction scan could not enumerate '$Dir' -- the scan is INCOMPLETE and must not be treated as 'no junctions found': $($_.Exception.Message)"
        }
        foreach ($child in $children) {
            Test-JunctionsWalk -Dir $child.FullName
        }
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
#
# A failed SCAN propagates out of here as a throw (see Get-JunctionsRecursive)
# rather than being reported as "0 junctions removed" — the caller must not be
# able to mistake an incomplete scan for a clean tree.
#
# The enumeration is repeated AFTER the delete loop and anything still (or
# newly) reparse-shaped is reported as an un-removed junction — see the
# comment at that re-scan for the window it closes.
#
# Every result object carries exactly these five properties, and
# scripts/wt-gc.mjs reads them by name (JUNCTION_RESULT_KEYS there):
#   Path, Target, Removed, TargetStillExists, Error
# Renaming one silently changes the JS side's reading — `TargetStillExists`
# especially, whose absence makes the "junction unlinked AND its real target
# destroyed" case read as success. The names are pinned from both sides:
# scripts/tests/wt-gc-junctions.Tests.ps1 asserts this module's output against
# wt-gc.mjs's list, and scripts/tests/wt-gc.test.mjs asserts that list against
# this file's source.
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

    # RE-SCAN, and report anything still reparse-shaped as an un-removed
    # junction. The enumerate-then-delete shape above leaves a window: a
    # junction created after Get-JunctionsRecursive returned -- an `npm
    # install` or a `wt-new.mjs` finishing inside this tree -- is live and
    # unseen when the caller goes on to `git worktree remove --force`, which
    # is exactly the follow-the-link-into-the-primary-checkout case this
    # module exists to prevent. Narrow (the caller only prunes a merged,
    # pushed, clean, PR-free, unlocked tree) but not closed by anything else.
    #
    # It REPORTS rather than deletes: a junction appearing mid-teardown means
    # something is actively writing in a tree that is about to be destroyed,
    # and that is a reason to stop, not to sweep harder. wt-gc.mjs's
    # `!j.Removed` check turns the entry into a prune failure BEFORE `git
    # worktree remove` runs. A path that already failed its delete above is
    # skipped, so it is reported once, not twice.
    $reported = @{}
    foreach ($r in @($results)) {
        if (-not $r.Removed) { $reported[$r.Path] = $true }
    }
    $final = New-Object System.Collections.Generic.List[object]
    foreach ($r in @($results)) { $final.Add($r) }
    foreach ($path in (Get-JunctionsRecursive -Root $Root)) {
        if ($reported.ContainsKey($path)) { continue }
        $final.Add([PSCustomObject]@{
            Path              = $path
            Target            = $null
            Removed           = $false
            TargetStillExists = $null
            Error             = "wt-gc: junction present at '$path' AFTER the removal pass -- created between the scan and the delete. Refusing to treat this tree as swept."
        })
    }
    return , @($final.ToArray())
}

Export-ModuleMember -Function Test-IsReparsePoint, Get-JunctionsRecursive, Remove-JunctionsRecursive
