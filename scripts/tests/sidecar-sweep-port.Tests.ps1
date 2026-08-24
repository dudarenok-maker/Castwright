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

    # #2632 N36 — must reject exactly the spellings the server's own
    # resolveSidecarPort() (server/src/tts/sidecar-owner.ts, N28) rejects.
    It 'rejects LOCAL_TTS_PORT spellings the server rejects (<Spelling>)' -TestCases @(
        @{ Spelling = '+9010' }
        @{ Spelling = '1e4' }
        @{ Spelling = '0x2386' }
        @{ Spelling = '9010.0' }
    ) {
        param($Spelling)
        Set-Content -Path $script:envPath -Value "LOCAL_TTS_PORT=$Spelling" -Encoding utf8
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be $null
    }

    It 'accepts a leading-zero spelling the server also accepts' {
        Set-Content -Path $script:envPath -Value "LOCAL_TTS_PORT=007" -Encoding utf8
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 7
    }

    It 'prefers a shell-set LOCAL_TTS_PORT over server\.env, mirroring process.loadEnvFile precedence' {
        Set-Content -Path $script:envPath -Value "LOCAL_TTS_PORT=9010" -Encoding utf8
        $prev = $env:LOCAL_TTS_PORT
        $env:LOCAL_TTS_PORT = '9100'
        try {
            Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9100
        } finally {
            if ($null -eq $prev) { Remove-Item Env:\LOCAL_TTS_PORT -ErrorAction SilentlyContinue }
            else { $env:LOCAL_TTS_PORT = $prev }
        }
    }

    # #2632 N42 — process.loadEnvFile takes the LAST assignment of a
    # duplicate key; this reader used to take the FIRST regex match, which
    # could sweep/force-kill a port the server never actually bound to.
    It 'takes the LAST LOCAL_TTS_PORT line on a duplicate key, matching process.loadEnvFile' {
        Set-Content -Path $script:envPath -Value "LOCAL_TTS_PORT=9010`nLOCAL_TTS_PORT=9020" -Encoding utf8
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9020
    }
}

Describe 'Get-ConfiguredServerPort / Get-ConfiguredVitePort (#2632 N39)' {
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

    It 'reads this checkout''s own PORT from server\.env' {
        Set-Content -Path $script:envPath -Value "PORT=8200`nWORKSPACE_DIR=..\workspace" -Encoding utf8
        Get-ConfiguredServerPort -ServerEnvPath $script:envPath | Should -Be 8200
    }

    It 'takes the LAST PORT line on a duplicate key' {
        Set-Content -Path $script:envPath -Value "PORT=8080`nPORT=8200" -Encoding utf8
        Get-ConfiguredServerPort -ServerEnvPath $script:envPath | Should -Be 8200
    }

    It 'returns $null (sweep nothing) when server\.env has no PORT line' {
        Set-Content -Path $script:envPath -Value "WORKSPACE_DIR=..\workspace" -Encoding utf8
        Get-ConfiguredServerPort -ServerEnvPath $script:envPath | Should -Be $null
    }

    It 'prefers a shell-set PORT over server\.env' {
        Set-Content -Path $script:envPath -Value "PORT=8200" -Encoding utf8
        $prev = $env:PORT
        $env:PORT = '8300'
        try {
            Get-ConfiguredServerPort -ServerEnvPath $script:envPath | Should -Be 8300
        } finally {
            if ($null -eq $prev) { Remove-Item Env:\PORT -ErrorAction SilentlyContinue }
            else { $env:PORT = $prev }
        }
    }

    It 'reads this checkout''s own VITE_PORT from .env.local' {
        Set-Content -Path $script:envPath -Value "VITE_PORT=5293`nPORT=8200" -Encoding utf8
        Get-ConfiguredVitePort -EnvLocalPath $script:envPath | Should -Be 5293
    }

    It 'returns $null (sweep nothing) when .env.local has no VITE_PORT line' {
        Set-Content -Path $script:envPath -Value "PORT=8200" -Encoding utf8
        Get-ConfiguredVitePort -EnvLocalPath $script:envPath | Should -Be $null
    }

    # #2632 N39 — stop-app.ps1 used to hardcode @(5173, 8080, 8443) as its
    # base sweep list, which is the PRIMARY checkout's ports regardless of
    # what THIS checkout is configured for. Behavioural: drives a
    # worktree-shaped server\.env through the real resolver the same way
    # stop-app.ps1's call site does, so a reversion has nowhere to hide.
    It 'resolves a worktree-shaped server\.env to its OWN port, not the primary''s 8080' {
        Set-Content -Path $script:envPath -Value "PORT=8090`nWORKSPACE_DIR=..\castwright-workspace`nLOCAL_TTS_PORT=9010" -Encoding utf8
        $resolved = Get-ConfiguredServerPort -ServerEnvPath $script:envPath
        $resolved | Should -Be 8090
        $resolved | Should -Not -Be 8080
    }
}

Describe 'Get-PortsToSweep (#2632 N34)' {
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

    # Behavioural, not source-text: this is the ENTIRE call-site computation
    # stop-app.ps1 uses, so mutating the call site to discard the resolved
    # port (pass 7's mutant G: `$ports = @(5173, 8080, 8443, 9000)`, resolver
    # still called) has nowhere to hide — there's no logic left at the call
    # site to independently mutate away from what's tested here.
    It 'includes the resolved sidecar port from tts.owner.json' {
        $notePath = Join-Path $script:tempDir "tts.owner.json"
        Set-Content -Path $notePath -Value '{"pid":1,"ppid":1,"port":9010,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8

        $ports = Get-PortsToSweep -BasePorts @(5173, 8080, 8443) -RunDir $script:tempDir -ServerEnvPath $script:envPath
        $ports | Should -Be @(5173, 8080, 8443, 9010)
    }

    It 'includes the resolved sidecar port from server\.env fallback' {
        Set-Content -Path $script:envPath -Value "LOCAL_TTS_PORT=9030" -Encoding utf8

        $ports = Get-PortsToSweep -BasePorts @(5173, 8080, 8443) -RunDir $script:tempDir -ServerEnvPath $script:envPath
        $ports | Should -Be @(5173, 8080, 8443, 9030)
    }

    It 'sweeps only the base ports when no sidecar port resolves' {
        $ports = Get-PortsToSweep -BasePorts @(5173, 8080, 8443) -RunDir $script:tempDir -ServerEnvPath $script:envPath
        $ports | Should -Be @(5173, 8080, 8443)
    }
}

Describe 'stop-app.ps1 call site (#2632 N34)' {
    # Narrow structural check on top of Get-PortsToSweep's behavioural
    # coverage: proves stop-app.ps1 actually feeds $ports from
    # Get-PortsToSweep, not a literal array assembled after calling it for
    # its side effects. Deliberately does NOT pin $ttsPort/$serverEnvPath —
    # pinning those identifiers is what reddened on a plain rename in pass 7.
    It '$ports is assigned from Get-PortsToSweep, not a hardcoded array' {
        $source = Get-Content (Join-Path $PSScriptRoot "..\stop-app.ps1") -Raw
        $source | Should -Match '\$ports\s*=\s*Get-PortsToSweep\b'
        $source | Should -Not -Match '\$ports\s*=\s*@\([^)]*9000[^)]*\)'
    }

    # #2632 N39 — the base-port half of the same hazard: stop-app.ps1 used to
    # pass a literal @(5173, 8080, 8443) as -BasePorts, which is the PRIMARY
    # checkout's ports regardless of what THIS checkout is configured for.
    It 'resolves its base ports via Get-ConfiguredServerPort/Get-ConfiguredVitePort, not a hardcoded 5173/8080' {
        $source = Get-Content (Join-Path $PSScriptRoot "..\stop-app.ps1") -Raw
        $source | Should -Match 'Get-ConfiguredServerPort\b'
        $source | Should -Match 'Get-ConfiguredVitePort\b'
        $source | Should -Not -Match '-BasePorts\s*@\(5173'
    }

    # #2632 N39 pass-8 follow-up — 8443 (LAN HTTPS) is not per-worktree
    # offset by wt-new.mjs, and unlike PORT/VITE_PORT its config alone can't
    # establish ownership of the currently-bound process (dev mode never
    # rebinds, so a losing checkout's LAN server never even starts — "my
    # config says LAN_HTTPS=1" doesn't mean "the thing on :8443 is mine").
    # $basePorts must never gain a literal 8443, in any form.
    It 'never assembles a literal 8443 into $basePorts' {
        $source = Get-Content (Join-Path $PSScriptRoot "..\stop-app.ps1") -Raw
        $source | Should -Not -Match '\$basePorts\s*=\s*@\(8443\)'
        $source | Should -Not -Match '\+\s*@\(8443\)'
        $source | Should -Not -Match '8443\)\s*\+\s*\$basePorts'
    }
}
