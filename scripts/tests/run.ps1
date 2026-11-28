#requires -Version 5.1
# Pester runner for PowerShell harness tests under scripts\tests\.
# Hard requirement: Pester 5.x (>= 5.0, < 6.0). The Windows-shipped 3.4
# module's API is incompatible with the syntax used in *.Tests.ps1, and
# Pester 6 fails every case, so we pin the highest 5.x, not the highest installed.

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here "..\lib\select-pester5.ps1")

$pester = Select-Pester5Module -Modules (Get-Module -ListAvailable -Name Pester)

if (-not $pester) {
    Get-Pester5InstallHint | ForEach-Object { Write-Host $_ }
    exit 1
}

Import-Module $pester.Path -RequiredVersion $pester.Version -Force

$config = New-PesterConfiguration
$config.Run.Path        = $here
$config.Run.Exit        = $true
$config.Output.Verbosity = 'Detailed'

Invoke-Pester -Configuration $config
