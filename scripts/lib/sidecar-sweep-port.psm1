#requires -Version 5.1
# #2632 N27/N29 — the sidecar port stop-app.ps1's belt-and-braces listener
# sweep targets is per-checkout since #2632 (LOCAL_TTS_PORT), not always the
# factory default :9000. A hardcoded 9000 in the sweep list force-kills
# whatever is listening there from a worktree whose own sidecar lives on a
# different port — typically the PRIMARY checkout's sidecar, mid-generation.
#
# The Node server already records the port it actually owns in
# .run\tts.owner.json (SidecarOwnerNote, server/src/tts/sidecar-owner.ts) the
# moment it claims ownership, so read THAT first. But the note is absent in
# three routine states (N29): after a clean shutdown (releaseSidecarOwnership
# unlinks it), with autoStartSidecar off (the note is never written), or when
# this checkout's own server\.env sets LOCAL_TTS_PORT but no sidecar has
# claimed it yet. Falling back to the factory default 9000 there is the one
# dangerous value — it is guaranteed to belong to a DIFFERENT checkout in
# exactly those states, and this script force-kills whatever answers on it.
# So the fallback instead reads LOCAL_TTS_PORT out of THIS checkout's own
# server\.env (server/src/load-env.ts's source, and the same file
# wt-new.mjs:166 writes per-worktree) — the port this checkout is actually
# configured for. Only when neither source yields a port does this return
# $null, meaning "don't sweep the TTS port at all" — never blind-kill 9000.
#
# Extracted into its own module (mirrors log-utils.psm1) so Pester can
# exercise the resolution logic without running the full stop sequence
# (which taskkills real processes).
# Single validity rule for a LOCAL_TTS_PORT spelling, shared with the
# server's own resolveSidecarPort() (server/src/tts/sidecar-owner.ts,
# hardened at #2632 N28): a plain decimal-integer spelling only, 1-65535.
# [int]::TryParse alone accepts a leading "+" ("+9010") that the server's
# `/^\d+$/` gate rejects — this must reject exactly what the server rejects
# (#2632 N36), or the sweep can target a port the server never bound to.
function Get-LocalTtsPortValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Raw
    )
    if ($Raw -notmatch '^\d+$') { return $null }
    $port = 0
    if ([int]::TryParse($Raw, [ref]$port) -and $port -gt 0 -and $port -lt 65536) {
        return $port
    }
    return $null
}

# Resolve a single `KEY=value` env line's port value out of an env-style
# file, mirroring process.loadEnvFile's own precedence and parsing rules —
# shared by LOCAL_TTS_PORT (server\.env), PORT (server\.env), and VITE_PORT
# (.env.local), the three env-sourced ports stop-app.ps1 sweeps (#2632 N39).
#
# Two things this MUST match about process.loadEnvFile, both measured
# directly against the real function rather than assumed:
# - #2632 N36: a shell-exported value wins over the file — loadEnvFile
#   never overwrites an already-present process.env entry, so if THIS shell
#   already has $Key set, that's the value the server would also resolve to.
# - #2632 N42: on a DUPLICATE key, loadEnvFile takes the LAST assignment
#   (later process.env[key] = value calls simply overwrite earlier ones) —
#   so this reader must take the last matching line too, not the first, or
#   it can target a port the server never actually bound to.
function Get-ConfiguredPortFromEnv {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Key,
        [string] $EnvPath
    )
    $envValue = [Environment]::GetEnvironmentVariable($Key)
    if ($envValue) {
        return Get-LocalTtsPortValue -Raw $envValue
    }
    if (-not $EnvPath -or -not (Test-Path $EnvPath)) { return $null }
    try {
        $lines = Get-Content $EnvPath -ErrorAction Stop
    } catch {
        return $null
    }
    $found = $null
    foreach ($line in $lines) {
        if ($line -match "^\s*$Key\s*=\s*(\S+)\s*$") {
            $found = $Matches[1]
        }
    }
    if ($null -eq $found) { return $null }
    return Get-LocalTtsPortValue -Raw $found
}

function Get-LocalTtsPortFromServerEnv {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $ServerEnvPath
    )
    return Get-ConfiguredPortFromEnv -Key 'LOCAL_TTS_PORT' -EnvPath $ServerEnvPath
}

# Resolve this checkout's own configured PORT (server\.env) — the same
# per-checkout, never-guess-the-primary's-value discipline as the TTS port,
# extended to the class of hardcoded base ports (#2632 N39): a worktree's
# server\.env always carries an explicit PORT (wt-new.mjs writes one per
# slot), so this resolves for every worktree; a hand-edited primary checkout
# with no PORT line returns $null, meaning "don't sweep the server port"
# rather than guessing :8080 — the same trade Get-SidecarSweepPort already
# makes for LOCAL_TTS_PORT.
function Get-ConfiguredServerPort {
    [CmdletBinding()]
    param(
        [string] $ServerEnvPath
    )
    return Get-ConfiguredPortFromEnv -Key 'PORT' -EnvPath $ServerEnvPath
}

# Resolve this checkout's own configured VITE_PORT (.env.local) — the
# Vite-side sibling of Get-ConfiguredServerPort (#2632 N39).
function Get-ConfiguredVitePort {
    [CmdletBinding()]
    param(
        [string] $EnvLocalPath
    )
    return Get-ConfiguredPortFromEnv -Key 'VITE_PORT' -EnvPath $EnvLocalPath
}

function Get-SidecarSweepPort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $RunDir,
        [string] $ServerEnvPath
    )
    $notePath = Join-Path $RunDir "tts.owner.json"
    if (Test-Path $notePath) {
        try {
            $note = Get-Content $notePath -Raw -ErrorAction Stop | ConvertFrom-Json
            if ($note.port -is [int] -or $note.port -is [long] -or $note.port -is [double]) {
                $port = [int]$note.port
                if ($port -gt 0 -and $port -lt 65536) { return $port }
            }
        } catch {
            # Corrupt/unreadable note — fall through to the server\.env fallback.
        }
    }
    if ($ServerEnvPath) { return Get-LocalTtsPortFromServerEnv -ServerEnvPath $ServerEnvPath }
    return $null
}

# Build the full list of ports stop-app.ps1 should sweep: the base ports
# (frontend/server/LAN-HTTPS) plus the resolved sidecar port, when one
# resolves. This is the ENTIRE call-site computation, not just the
# port-resolution step — pulled out so the exact list stop-app.ps1 sweeps is
# itself Pester-testable, rather than only Get-SidecarSweepPort in isolation.
# #2632 N34: a call site that stops USING the resolved port (while still
# calling the resolver) must redden a test — that requires testing the
# assembled list, not the resolver alone.
function Get-PortsToSweep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int[]] $BasePorts,
        [Parameter(Mandatory)]
        [string] $RunDir,
        [string] $ServerEnvPath
    )
    $ttsPort = Get-SidecarSweepPort -RunDir $RunDir -ServerEnvPath $ServerEnvPath
    if ($ttsPort) { return @($BasePorts) + @($ttsPort) }
    return @($BasePorts)
}

Export-ModuleMember -Function Get-SidecarSweepPort, Get-LocalTtsPortFromServerEnv, Get-PortsToSweep, Get-LocalTtsPortValue, Get-ConfiguredPortFromEnv, Get-ConfiguredServerPort, Get-ConfiguredVitePort
