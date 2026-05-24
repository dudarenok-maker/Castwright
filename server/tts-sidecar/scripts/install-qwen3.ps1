# install-qwen3.ps1 -- thin Windows wrapper around install-qwen3.mjs (plan 108).
#
# The real installer is cross-platform Node ESM (install-qwen3.mjs) per the
# deployer-spread convention; this wrapper exists only so Windows users who
# reach for a .ps1 (and the Account-tab install card) have a discoverable
# entry point. It just forwards to node with the same args.
#
# ASCII-only per repo convention (Windows PowerShell 5.1 reads UTF-8 without
# BOM as Win-1252 and mojibakes em-dashes/smart-quotes).

[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Forward
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) {
    $ScriptDir = (Get-Location).Path
}
$Mjs = Join-Path $ScriptDir 'install-qwen3.mjs'

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Write-Host "[install-qwen3] FAIL: 'node' is not on PATH. Install Node 20.6+ first."
    exit 1
}

Write-Host "[install-qwen3] Forwarding to: node `"$Mjs`" $Forward"
& node $Mjs @Forward
exit $LASTEXITCODE
