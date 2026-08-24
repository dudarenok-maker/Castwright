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
function Get-LocalTtsPortFromServerEnv {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $ServerEnvPath
    )
    if (-not (Test-Path $ServerEnvPath)) { return $null }
    try {
        $lines = Get-Content $ServerEnvPath -ErrorAction Stop
    } catch {
        return $null
    }
    foreach ($line in $lines) {
        if ($line -match '^\s*LOCAL_TTS_PORT\s*=\s*(\S+)\s*$') {
            $port = 0
            if ([int]::TryParse($Matches[1], [ref]$port) -and $port -gt 0 -and $port -lt 65536) {
                return $port
            }
            return $null
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

Export-ModuleMember -Function Get-SidecarSweepPort, Get-LocalTtsPortFromServerEnv
