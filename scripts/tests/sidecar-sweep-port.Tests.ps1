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

    # #2632 N52 — `Set-Content -Encoding utf8` WRITES a UTF-8 BOM under
    # Windows PowerShell 5.1 (measured: `ef bb bf 4c` — the file's own
    # fixtures were quietly exercising the BOM-prefixed cell on every run
    # under 5.1, never the plain one, and could never surface a BOM/no-BOM
    # divergence either way). Write exact bytes instead so a test controls
    # precisely what it means to test. No-BOM is the default for every
    # existing "plain env content" fixture; Set-EnvFixtureWithBom exists
    # only for the dedicated BOM cell below. Defined here (inside BeforeAll,
    # like the module import above) rather than at script scope: Pester 5
    # runs discovery and Run in separate passes, and a plain top-level
    # `function` from discovery is not guaranteed visible to It blocks in Run.
    function Set-EnvFixture {
        [CmdletBinding()]
        param(
            [Parameter(Mandatory)] [string] $Path,
            [Parameter(Mandatory)] [string] $Content
        )
        [System.IO.File]::WriteAllBytes($Path, [System.Text.Encoding]::UTF8.GetBytes($Content))
    }

    function Set-EnvFixtureWithBom {
        [CmdletBinding()]
        param(
            [Parameter(Mandatory)] [string] $Path,
            [Parameter(Mandatory)] [string] $Content
        )
        $bom = [byte[]](0xEF, 0xBB, 0xBF)
        $bytes = $bom + [System.Text.Encoding]::UTF8.GetBytes($Content)
        [System.IO.File]::WriteAllBytes($Path, $bytes)
    }
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

    It 'returns the per-checkout port recorded in tts.owner.<port>.json over server\.env (#2632 N27 fix)' {
        $notePath = Join-Path $script:tempDir "tts.owner.9010.json"
        Set-Content -Path $notePath -Value '{"pid":1234,"ppid":1,"port":9010,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9020"

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9010
    }

    It 'falls back to server\.env LOCAL_TTS_PORT when no tts.owner.<port>.json note exists (#2632 N29)' {
        Set-EnvFixture -Path $script:envPath -Content "PORT=8080`nLOCAL_TTS_PORT=9030"

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9030
    }

    It 'falls back to server\.env LOCAL_TTS_PORT when tts.owner.<port>.json is corrupt JSON' {
        $notePath = Join-Path $script:tempDir "tts.owner.9040.json"
        Set-Content -Path $notePath -Value 'not valid json {{{' -Encoding utf8
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9040"

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9040
    }

    It 'falls back to server\.env LOCAL_TTS_PORT when the recorded port is out of range' {
        $notePath = Join-Path $script:tempDir "tts.owner.99999.json"
        Set-Content -Path $notePath -Value '{"pid":1234,"ppid":1,"port":99999,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9050"

        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9050
    }

    It 'returns $null (sweep nothing) when neither the note nor server\.env yield a port (#2632 N29)' {
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be $null
    }

    It 'falls back to server\.env LOCAL_TTS_PORT when two note files exist in the same run dir (#2641 shared-run-dir scenario)' {
        $notePathA = Join-Path $script:tempDir "tts.owner.9010.json"
        $notePathB = Join-Path $script:tempDir "tts.owner.9011.json"
        Set-Content -Path $notePathA -Value '{"pid":1234,"ppid":1,"port":9010,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-Content -Path $notePathB -Value '{"pid":5678,"ppid":1,"port":9011,"startedAt":"2026-08-25T00:00:01.000Z"}' -Encoding utf8
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9060"

        # Two candidate notes, no way to tell which is current — must not
        # guess between them; fall back exactly as the zero-match case does.
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9060
    }

    It 'falls back to server\.env LOCAL_TTS_PORT when the only tts.owner.*.json file has a non-numeric port segment (#2641 digits-only fix)' {
        $notePath = Join-Path $script:tempDir "tts.owner.stale.json"
        Set-Content -Path $notePath -Value '{"pid":1234,"ppid":1,"port":9075,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9070"

        # -Filter's '*' wildcard would count this as the sole match and trust
        # its (wrong) port 9075; the port segment must be digits-only,
        # mirroring the .mjs resolver's /^tts\.owner\.\d+\.json$/ exactly, so
        # this must fall back to server\.env's 9070 instead of trusting a
        # malformed filename.
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9070
    }

    It 'returns $null when server\.env has no LOCAL_TTS_PORT line' {
        Set-EnvFixture -Path $script:envPath -Content "PORT=8080`nWORKSPACE_DIR=..\workspace"

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
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=$Spelling"
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be $null
    }

    It 'accepts a leading-zero spelling the server also accepts' {
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=007"
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 7
    }

    It 'prefers a shell-set LOCAL_TTS_PORT over server\.env, mirroring process.loadEnvFile precedence' {
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9010"
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
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9010`nLOCAL_TTS_PORT=9020"
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9020
    }

    # #2632 N52 — a server\.env whose first bytes are a UTF-8 BOM (EF BB BF)
    # decodes to a leading U+FEFF. process.loadEnvFile does NOT strip that
    # BOM before parsing keys, so the BOM-prefixed first line's key is
    # literally "<BOM>LOCAL_TTS_PORT" — the server's own resolveSidecarPort()
    # never sees plain LOCAL_TTS_PORT and falls back to 9000. Measured
    # directly against process.loadEnvFile (not assumed): with this exact
    # byte layout, process.env.LOCAL_TTS_PORT stays undefined. This reader
    # must resolve $null here too, matching the server, not 9010 — the exact
    # cross-checkout kill hazard this sweep exists to prevent.
    It 'returns $null on a BOM-prefixed LOCAL_TTS_PORT line, matching process.loadEnvFile' {
        Set-EnvFixtureWithBom -Path $script:envPath -Content "LOCAL_TTS_PORT=9010"
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be $null
    }

    It 'still resolves LOCAL_TTS_PORT with no BOM present (control for the BOM cell)' {
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9010"
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9010
    }

    # #2632 N52 — a duplicate key whose LAST occurrence carries a trailing
    # comment. Measured directly against process.loadEnvFile: it strips the
    # inline `# comment` from an unquoted value and takes the LAST
    # assignment, so this content resolves process.env.LOCAL_TTS_PORT to
    # "9011". A reader whose match requires the captured token to run to
    # end-of-line (no trailing comment) fails to match that last line at
    # all and silently falls back to the EARLIER value (9010) the server
    # has already overwritten.
    It 'takes the LAST duplicate value even when it carries a trailing comment, matching process.loadEnvFile' {
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9010`nLOCAL_TTS_PORT=9011 # comment"
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9011
    }

    # #2754 review finding — the regex must be case-sensitive and use ASCII
    # digits only, matching the .mjs twin exactly. PowerShell's -match is
    # case-insensitive by default and .NET \d is Unicode-digit-aware, so
    # the regex must use -cmatch and [0-9] to align with JS /^tts\.owner\.\d+\.json$/.
    It 'rejects uppercase tts.owner.*.json filename (case-sensitive matching only)' {
        # Create a single uppercase file: -match would accept it (case-insensitive),
        # but -cmatch should reject it and fall back to server\.env
        $notePathUpper = Join-Path $script:tempDir "TTS.OWNER.9000.JSON"
        Set-Content -Path $notePathUpper -Value '{"pid":1234,"ppid":1,"port":9000,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9070"

        # Uppercase file should NOT be trusted; fall back to server\.env with -cmatch
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9070
    }

    It 'rejects mixed-case tts.owner.*.json filename (case-sensitive matching only)' {
        # Create a single mixed-case file
        $notePathMixed = Join-Path $script:tempDir "Tts.Owner.9010.Json"
        Set-Content -Path $notePathMixed -Value '{"pid":5678,"ppid":1,"port":9010,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9070"

        # Mixed-case file should NOT be trusted; fall back to server\.env with -cmatch
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9070
    }

    It 'matches lowercase tts.owner.*.json (control for the case-sensitivity cell)' {
        $notePath = Join-Path $script:tempDir "tts.owner.9010.json"
        Set-Content -Path $notePath -Value '{"pid":1234,"ppid":1,"port":9010,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9070"

        # Lowercase tts.owner.9010.json should be matched and trusted
        Get-SidecarSweepPort -RunDir $script:tempDir -ServerEnvPath $script:envPath | Should -Be 9010
    }
}

# #2632 N53 — stop-app.ps1 used to print "[OK] nothing to stop"
# unconditionally whenever no PID kill happened, even after a
# Stop-Process sweep-kill was denied, or when zero ports even resolved for
# this checkout (so nothing was actually checked). Both are false
# reassurance distinct from "checked known ports and found them clear".
Describe 'Get-StopSummaryMessage (#2632 N53)' {
    It 'returns $null when a PID kill happened (per-item lines already said so)' {
        Get-StopSummaryMessage -KilledAny $true -SweepIncomplete $false -Ports @(8080) | Should -Be $null
    }

    It 'returns $null when the sweep is incomplete (a Stop-Process kill was denied)' {
        Get-StopSummaryMessage -KilledAny $false -SweepIncomplete $true -Ports @(8080) | Should -Be $null
    }

    It 'distinguishes "no ports resolved" from "checked and clear"' {
        Get-StopSummaryMessage -KilledAny $false -SweepIncomplete $false -Ports @() |
            Should -Be "[OK] nothing to stop (no ports resolved for this checkout)"
        Get-StopSummaryMessage -KilledAny $false -SweepIncomplete $false -Ports @(8080) |
            Should -Be "[OK] nothing to stop"
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
        Set-EnvFixture -Path $script:envPath -Content "PORT=8200`nWORKSPACE_DIR=..\workspace"
        Get-ConfiguredServerPort -ServerEnvPath $script:envPath | Should -Be 8200
    }

    It 'takes the LAST PORT line on a duplicate key' {
        Set-EnvFixture -Path $script:envPath -Content "PORT=8080`nPORT=8200"
        Get-ConfiguredServerPort -ServerEnvPath $script:envPath | Should -Be 8200
    }

    It 'returns $null (sweep nothing) when server\.env has no PORT line' {
        Set-EnvFixture -Path $script:envPath -Content "WORKSPACE_DIR=..\workspace"
        Get-ConfiguredServerPort -ServerEnvPath $script:envPath | Should -Be $null
    }

    It 'prefers a shell-set PORT over server\.env' {
        Set-EnvFixture -Path $script:envPath -Content "PORT=8200"
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
        Set-EnvFixture -Path $script:envPath -Content "VITE_PORT=5293`nPORT=8200"
        Get-ConfiguredVitePort -EnvLocalPath $script:envPath | Should -Be 5293
    }

    It 'returns $null (sweep nothing) when .env.local has no VITE_PORT line' {
        Set-EnvFixture -Path $script:envPath -Content "PORT=8200"
        Get-ConfiguredVitePort -EnvLocalPath $script:envPath | Should -Be $null
    }

    # #2632 N39 — stop-app.ps1 used to hardcode @(5173, 8080, 8443) as its
    # base sweep list, which is the PRIMARY checkout's ports regardless of
    # what THIS checkout is configured for. Behavioural: drives a
    # worktree-shaped server\.env through the real resolver the same way
    # stop-app.ps1's call site does, so a reversion has nowhere to hide.
    It 'resolves a worktree-shaped server\.env to its OWN port, not the primary''s 8080' {
        Set-EnvFixture -Path $script:envPath -Content "PORT=8090`nWORKSPACE_DIR=..\castwright-workspace`nLOCAL_TTS_PORT=9010"
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
    It 'includes the resolved sidecar port from tts.owner.<port>.json' {
        $notePath = Join-Path $script:tempDir "tts.owner.9010.json"
        Set-Content -Path $notePath -Value '{"pid":1,"ppid":1,"port":9010,"startedAt":"2026-08-25T00:00:00.000Z"}' -Encoding utf8

        $ports = Get-PortsToSweep -BasePorts @(5173, 8080, 8443) -RunDir $script:tempDir -ServerEnvPath $script:envPath
        $ports | Should -Be @(5173, 8080, 8443, 9010)
    }

    It 'includes the resolved sidecar port from server\.env fallback' {
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9030"

        $ports = Get-PortsToSweep -BasePorts @(5173, 8080, 8443) -RunDir $script:tempDir -ServerEnvPath $script:envPath
        $ports | Should -Be @(5173, 8080, 8443, 9030)
    }

    It 'sweeps only the base ports when no sidecar port resolves' {
        $ports = Get-PortsToSweep -BasePorts @(5173, 8080, 8443) -RunDir $script:tempDir -ServerEnvPath $script:envPath
        $ports | Should -Be @(5173, 8080, 8443)
    }

    # #2632 N46 — a checkout with neither .env.local nor a server\.env PORT
    # line (the primary checkout's actual today-state, and the default for
    # anything derived from server/.env.example) resolves $basePorts to an
    # EMPTY array at the stop-app.ps1 call site. [Parameter(Mandatory)] alone
    # on an [int[]] rejects an empty array at bind time — before the function
    # body even runs — so this shape must be exercised directly, not just
    # inferred from the non-empty cases above.
    It 'returns an empty array (never throws) when BasePorts is empty and no sidecar port resolves' {
        $ports = Get-PortsToSweep -BasePorts @() -RunDir $script:tempDir -ServerEnvPath $script:envPath
        $ports | Should -Be @()
    }

    It 'returns just the sidecar port when BasePorts is empty but LOCAL_TTS_PORT=9010 resolves' {
        Set-EnvFixture -Path $script:envPath -Content "LOCAL_TTS_PORT=9010"
        $ports = Get-PortsToSweep -BasePorts @() -RunDir $script:tempDir -ServerEnvPath $script:envPath
        $ports | Should -Be @(9010)
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
