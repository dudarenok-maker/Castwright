#requires -Version 5.1
# Pester 5.x tests for scripts\lib\sidecar-sweep-port.psm1 (#2632 N27/N29).
# Invoke via scripts\tests\run.ps1 (npm run test:scripts).
#
# N29: the owner note is absent in routine states (clean shutdown,
# autoStartSidecar off, no sidecar claimed yet this run). Falling back to the
# factory default 9000 there is itself the hazard it belongs to a DIFFERENT
# checkout most of the time, so the fallback instead reads LOCAL_TTS_PORT out
# of this checkout's own server\.env, and returns $null (sweep nothing) only
# when neither source yields a port.

BeforeAll {
    $modulePath = Join-Path $PSScriptRoot "..\lib\sidecar-sweep-port.psm1"
    Import-Module $modulePath -Force
}

Describe 'Get-SidecarSweepPort' {
    BeforeEach {
        $script:tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "sweep-port-$([Guid]::NewGuid())"
        New-Item -ItemType Directory -Path $script:tempDir | Out-Null
        $script:envPath = Join-Path $script:tempDir "server.env"
    }
    AfterEach {
        if (Test-Path $script:tempDir) {
            Remove-Item $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'returns the per-checkout port recorded in tts.owner.json over server\.env (#2632 N27 fix)' {
        $notePath = Join-Path $script:tempDir "tts.owner.json"
        Set-Content -Path $notePath -Value '{"pid":1234,"ppid":1,"port":9010,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-Content -Path $script:envPath -Value "LOCAL_TTS_PORT=9020" -Encoding utf8

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9010
    }

    It 'falls back to server\.env LOCAL_TTS_PORT when tts.owner.json is absent (#2632 N29)' {
        Set-Content -Path $script:envPath -Value "PORT=8080`nLOCAL_TTS_PORT=9030" -Encoding utf8

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9030
    }

    It 'falls back to server\.env LOCAL_TTS_PORT when tts.owner.json is corrupt JSON' {
        $notePath = Join-Path $script:tempDir "tts.owner.json"
        Set-Content -Path $notePath -Value 'not valid json {{{' -Encoding utf8
        Set-Content -Path $script:envPath -Value "LOCAL_TTS_PORT=9040" -Encoding utf8

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9040
    }

    It 'falls back to server\.env LOCAL_TTS_PORT when the recorded port is out of range' {
        $notePath = Join-Path $script:tempDir "tts.owner.json"
        Set-Content -Path $notePath -Value '{"pid":1234,"ppid":1,"port":99999,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-Content -Path $script:envPath -Value "LOCAL_TTS_PORT=9050" -Encoding utf8

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9050
    }

    It 'returns $null (sweep nothing) when neither the note nor server\.env yield a port (#2632 N29)' {
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be $null
    }

    It 'returns $null when server\.env has no LOCAL_TTS_PORT line' {
        Set-Content -Path $script:envPath -Value "PORT=8080`nWORKSPACE_DIR=..\workspace" -Encoding utf8

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be $null
    }

    It 'never returns the factory-default 9000 as a blind guess (#2632 N29)' {
        # No note, no server\.env at all (ServerEnvPath omitted).
        Get-SidecarSweepPort -RunDir $script:tempDir | Should -Not -Be 9000
    }
}

Describe 'stop-app.ps1 call site (#2632 N29)' {
    It 'computes $ttsPort via Get-SidecarSweepPort, not a literal 9000' {
        $source = Get-Content (Join-Path $PSScriptRoot "..\stop-app.ps1") -Raw
        $source | Should -Match '\$ttsPort = Get-SidecarSweepPort -RunDir \$runDir -ServerEnvPath \$serverEnvPath'
        $source | Should -Not -Match '\$ttsPort = 9000'
    }
}
