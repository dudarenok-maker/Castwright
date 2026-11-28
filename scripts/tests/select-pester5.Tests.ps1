#requires -Version 5.1
# Pester 5.x tests for scripts\lib\select-pester5.ps1 (the runner's version pin).

BeforeAll {
    . (Join-Path $PSScriptRoot "..\lib\select-pester5.ps1")
    function New-FakeModule([string]$v) { [pscustomobject]@{ Name = 'Pester'; Version = [Version]$v } }
}

Describe 'Select-Pester5Module' {
    It 'picks 5.7.1 over 6.1.0' {
        $r = Select-Pester5Module -Modules @((New-FakeModule '6.1.0'), (New-FakeModule '5.7.1'), (New-FakeModule '3.4.0'))
        $r.Version | Should -Be ([Version]'5.7.1')
    }
    It 'picks the highest 5.x when only 5.x is present' {
        $r = Select-Pester5Module -Modules @((New-FakeModule '5.0.0'), (New-FakeModule '5.5.0'), (New-FakeModule '3.4.0'))
        $r.Version | Should -Be ([Version]'5.5.0')
    }
    It 'returns nothing when only 6.x and 3.x are present' {
        Select-Pester5Module -Modules @((New-FakeModule '6.1.0'), (New-FakeModule '3.4.0')) | Should -BeNullOrEmpty
    }
    It 'returns nothing, without a binding error, for $null (no Pester installed)' {
        Select-Pester5Module -Modules (Get-Module -ListAvailable -Name 'NoSuchModule-x') | Should -BeNullOrEmpty
        Select-Pester5Module -Modules $null | Should -BeNullOrEmpty
    }
}

Describe 'run.ps1 on a host with no Pester at all' {
    It 'prints the install hint and exits 1 (no binding error)' {
        # A shadowing Get-Module makes the child see no Pester, whatever this
        # box has installed (pwsh appends its own module paths to PSModulePath,
        # so an empty PSModulePath is not hermetic).
        $shell = (Get-Process -Id $PID).Path
        $runner = (Resolve-Path (Join-Path $PSScriptRoot 'run.ps1')).Path
        $cmd = "function Get-Module { `$null }; & '$runner'; exit `$LASTEXITCODE"
        $out = & $shell -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1 | Out-String
        $LASTEXITCODE | Should -Be 1
        $out | Should -Match 'Pester 5\.x'
        $out | Should -Not -Match 'Cannot bind'
    }
}

Describe 'Get-Pester5InstallHint' {
    It 'mentions the 5.x pin and the 6-present case' {
        $h = (Get-Pester5InstallHint) -join "`n"
        $h | Should -Match 'Pester 5\.x'
        $h | Should -Match '-RequiredVersion 5\.7\.1'
        $h | Should -Match '-MaximumVersion 5\.99'
    }
}
