# Version pin for scripts\tests\run.ps1: the suite needs Pester 5.x. Pester 6
# fails every case ("Export-ModuleMember cmdlet can only be called from inside
# a module"), so the highest installed module is NOT the right pick.

function Select-Pester5Module {
    param([Parameter(Mandatory)][AllowNull()][AllowEmptyCollection()][object[]]$Modules)
    $Modules |
        Where-Object { $_.Version -ge [Version]'5.0.0' -and $_.Version -lt [Version]'6.0.0' } |
        Sort-Object Version -Descending |
        Select-Object -First 1
}

function Get-Pester5InstallHint {
    @(
        "Pester 5.x (>= 5.0, < 6.0) is required for PowerShell harness tests."
        "Pester 6 is not supported yet, and the Windows-shipped 3.4 is too old."
        ""
        "Install once (current user, no admin needed):"
        "  Install-Module -Name Pester -RequiredVersion 5.7.1 -Scope CurrentUser -Force -SkipPublisherCheck"
        "  (or, to take the newest 5.x: -MaximumVersion 5.99 instead of -RequiredVersion)"
        ""
        "Then re-run: npm run test:scripts"
    )
}
