#requires -Version 5.1
# #2632 N27 — the sidecar port stop-app.ps1's belt-and-braces listener sweep
# targets is per-checkout since #2632 (LOCAL_TTS_PORT), not always the
# factory default :9000. A hardcoded 9000 in the sweep list force-kills
# whatever is listening there from a worktree whose own sidecar lives on a
# different port — typically the PRIMARY checkout's sidecar, mid-generation.
#
# The Node server already records the port it actually owns in
# .run\tts.owner.json (SidecarOwnerNote, server/src/tts/sidecar-owner.ts) the
# moment it claims ownership, so read THAT instead of assuming 9000. Absent
# or unreadable — no sidecar ever claimed ownership this run, or the note is
# corrupt — falls back to the factory default 9000, the prior behaviour.
#
# Extracted into its own module (mirrors log-utils.psm1) so Pester can
# exercise the resolution logic without running the full stop sequence
# (which taskkills real processes).
function Get-SidecarSweepPort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $RunDir
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
            # Corrupt/unreadable note — fall through to the default.
        }
    }
    return 9000
}

Export-ModuleMember -Function Get-SidecarSweepPort
