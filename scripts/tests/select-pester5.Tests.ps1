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
}

Describe 'Get-Pester5InstallHint' {
    It 'mentions the 5.x pin and the 6-present case' {
        $h = (Get-Pester5InstallHint) -join "`n"
        $h | Should -Match 'Pester 5\.x'
        $h | Should -Match '-RequiredVersion 5\.7\.1'
        $h | Should -Match '-MaximumVersion 5\.99'
    }
}
