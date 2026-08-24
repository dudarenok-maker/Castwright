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

function Get-LocalTtsPortFromServerEnv {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $ServerEnvPath
    )
    # #2632 N36 — process.loadEnvFile (server/src/load-env.ts) does NOT
    # overwrite an already-present process.env entry, so a shell-exported
    # LOCAL_TTS_PORT wins over server\.env for the real server process too.
    # Mirror that precedence here: if THIS shell has LOCAL_TTS_PORT set,
    # that's the value the server would also resolve to — prefer it over
    # the file rather than naming a configured-but-overridden port.
    if ($env:LOCAL_TTS_PORT) {
        return Get-LocalTtsPortValue -Raw $env:LOCAL_TTS_PORT
    }
    if (-not (Test-Path $ServerEnvPath)) { return $null }
    try {
        $lines = Get-Content $ServerEnvPath -ErrorAction Stop
    } catch {
        return $null
    }
    foreach ($line in $lines) {
        if ($line -match '^\s*LOCAL_TTS_PORT\s*=\s*(\S+)\s*$') {
            return Get-LocalTtsPortValue -Raw $Matches[1]
        }
    }
    return $null
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

Export-ModuleMember -Function Get-SidecarSweepPort, Get-LocalTtsPortFromServerEnv, Get-PortsToSweep, Get-LocalTtsPortValue
