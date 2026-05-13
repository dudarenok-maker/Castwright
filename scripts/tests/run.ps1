#requires -Version 5.1
# Pester runner for PowerShell harness tests under scripts\tests\.
# Hard requirement: Pester >= 5.0. The Windows-shipped 3.4 module's API
# is incompatible with the syntax used in *.Tests.ps1.

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$pester = Get-Module -ListAvailable -Name Pester |
    Where-Object { $_.Version -ge [Version]'5.0.0' } |
    Sort-Object Version -Descending |
    Select-Object -First 1

if (-not $pester) {
    Write-Host "Pester >= 5.0 is required for PowerShell harness tests."
    Write-Host ""
    Write-Host "Install once (current user, no admin needed):"
    Write-Host "  Install-Module -Name Pester -Scope CurrentUser -Force -SkipPublisherCheck"
    Write-Host ""
    Write-Host "Then re-run: npm run test:scripts"
    exit 1
}

Import-Module $pester -Force

$config = New-PesterConfiguration
$config.Run.Path        = $here
$config.Run.Exit        = $true
$config.Output.Verbosity = 'Detailed'

Invoke-Pester -Configuration $config
