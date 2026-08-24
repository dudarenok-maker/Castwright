#requires -Version 5.1
# Pester 5.x tests for scripts\lib\sidecar-sweep-port.psm1 (#2632 N27).
# Invoke via scripts\tests\run.ps1 (npm run test:scripts).

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot "..\lib\sidecar-sweep-port.psm1"
    Import-Module $modulePath -Force
}

Describe 'Get-SidecarSweepPort' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "sweep-port-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'returns the per-checkout port recorded in tts.owner.json (#2632 N27 fix)' {
        $notePath = Join-Path $script:tempDir "tts.owner.json"
        Set-Content -Path $notePath -Value '{"pid":1234,"ppid":1,"port":9010,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8

        Get-SidecarSweepPort -RunDir $script:tempDir | Should -Be 9010
    }

    It 'falls back to 9000 when tts.owner.json is absent (this checkout never claimed a sidecar)' {
        Get-SidecarSweepPort -RunDir $script:tempDir | Should -Be 9000
    }

    It 'falls back to 9000 when tts.owner.json is corrupt JSON' {
        $notePath = Join-Path $script:tempDir "tts.owner.json"
        Set-Content -Path $notePath -Value 'not valid json {{{' -Encoding utf8

        Get-SidecarSweepPort -RunDir $script:tempDir | Should -Be 9000
    }

    It 'falls back to 9000 when the recorded port is out of range' {
        $notePath = Join-Path $script:tempDir "tts.owner.json"
        Set-Content -Path $notePath -Value '{"pid":1234,"ppid":1,"port":99999,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8

        Get-SidecarSweepPort -RunDir $script:tempDir | Should -Be 9000
    }
}
