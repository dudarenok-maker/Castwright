#requires -Version 5.1
# CLI wrapper around wt-gc-junctions.psm1's Get-JunctionsRecursive /
# Remove-JunctionsRecursive, spawned by scripts/wt-gc.mjs to get a
# JSON-serialized report back over stdout. See that module for the
# ReparsePoint-vs-.LinkTarget rationale.
#
# Usage: wt-gc-junctions.ps1 -Root <path> -Action Find|Remove
#
# Always emits `{"items": [...]}` (never a bare array) so a 0- or 1-element
# result round-trips through ConvertTo-Json/JSON.parse unambiguously —
# ConvertTo-Json in Windows PowerShell 5.1 has no -AsArray switch and
# unwraps a single-element array to a scalar, which would otherwise silently
# change shape depending on how many junctions were found.
param(
    [Parameter(Mandatory)]
    [string] $Root,

    [Parameter(Mandatory)]
    [ValidateSet('Find', 'Remove')]
    [string] $Action
)

Import-Module (Join-Path $PSScriptRoot 'wt-gc-junctions.psm1') -Force

$items = if ($Action -eq 'Find') {
    Get-JunctionsRecursive -Root $Root
} else {
    Remove-JunctionsRecursive -Root $Root
}

[PSCustomObject]@{ items = @($items) } | ConvertTo-Json -Depth 6
