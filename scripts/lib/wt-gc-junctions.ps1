#requires -Version 5.1
# CLI wrapper around wt-gc-junctions.psm1's Get-JunctionsRecursive /
# Remove-JunctionsRecursive, spawned by scripts/wt-gc.mjs to get a
# JSON-serialized report back over stdout. See that module for the
# ReparsePoint-vs-.LinkTarget rationale.
#
# Usage: wt-gc-junctions.ps1 -Root <path> -Action Remove
#
# `Remove` is the ONLY action. A `Find` branch existed and was unreachable —
# wt-gc.mjs's runJunctionScript() is only ever called with 'Remove' — and it
# was shape-mismatched besides: Get-JunctionsRecursive returns an array of
# STRINGS, so had anything ever routed it through wt-gc.mjs's report loop,
# `!j.Removed` would have been truthy for every string and every junction
# would have read as a failure. Removed rather than documented, so the shape
# mismatch cannot be reintroduced by accident. For an ad-hoc read-only look,
# import the module and call Get-JunctionsRecursive directly.
#
# Always emits `{"items": [...]}` (never a bare array) so a 0- or 1-element
# result round-trips through ConvertTo-Json/JSON.parse unambiguously —
# ConvertTo-Json in Windows PowerShell 5.1 has no -AsArray switch and
# unwraps a single-element array to a scalar, which would otherwise silently
# change shape depending on how many junctions were found.
#
# A failed junction SCAN throws out of the module (fail-closed — see the
# .psm1 header). That is caught here and turned into a non-zero exit with the
# message on stderr, so wt-gc.mjs's runJunctionScript() raises rather than
# parsing an empty, plausible-looking `{"items": []}`.
param(
    [Parameter(Mandatory)]
    [string] $Root,

    [Parameter(Mandatory)]
    [ValidateSet('Remove')]
    [string] $Action
)

Import-Module (Join-Path $PSScriptRoot 'wt-gc-junctions.psm1') -Force

try {
    $items = Remove-JunctionsRecursive -Root $Root
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 3
}

[PSCustomObject]@{ items = @($items) } | ConvertTo-Json -Depth 6
