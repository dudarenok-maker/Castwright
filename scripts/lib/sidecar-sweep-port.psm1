#requires -Version 5.1
# #2632 N27/N29 — the sidecar port stop-app.ps1's belt-and-braces listener
# sweep targets is per-checkout since #2632 (LOCAL_TTS_PORT), not always the
# factory default :9000. A hardcoded 9000 in the sweep list force-kills
# whatever is listening there from a worktree whose own sidecar lives on a
# different port — typically the PRIMARY checkout's sidecar, mid-generation.
#
# The Node server already records the port it actually owns in a port-keyed
# .run\tts.owner.<port>.json (SidecarOwnerNote, server/src/tts/sidecar-owner.ts)
# the moment it claims ownership, so read THAT first — glob the run dir for
# tts.owner.*.json and trust it only when exactly one such file exists (two or
# more means this run dir is shared across ports, #2641, and neither can be
# trusted over the other; zero means no sidecar has claimed a note here). But
# the note is absent in three routine states (N29): after a clean shutdown
# (releaseSidecarOwnership unlinks it), with autoStartSidecar off (the note is
# never written), or when this checkout's own server\.env sets LOCAL_TTS_PORT
# but no sidecar has claimed it yet. Falling back to the factory default 9000
# there is the one dangerous value — it is guaranteed to belong to a DIFFERENT
# checkout in exactly those states, and this script force-kills whatever
# answers on it.
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
# Four things this MUST match about process.loadEnvFile, all measured
# directly against the real function rather than assumed:
# - #2632 N36: a shell-exported value wins over the file — loadEnvFile
#   never overwrites an already-present process.env entry, so if THIS shell
#   already has $Key set, that's the value the server would also resolve to.
# - #2632 N42: on a DUPLICATE key, loadEnvFile takes the LAST assignment
#   (later process.env[key] = value calls simply overwrite earlier ones) —
#   so this reader must take the last matching line too, not the first, or
#   it can target a port the server never actually bound to.
# - #2632 N52 — BOM: `Get-Content` auto-detects and SILENTLY STRIPS a
#   leading UTF-8 BOM (measured directly: a BOM-prefixed file's first
#   character reads as 'L', not U+FEFF, through `Get-Content -Raw`).
#   process.loadEnvFile does NOT strip it — the BOM-prefixed first line's
#   key is literally "<BOM>LOCAL_TTS_PORT", which never matches plain
#   "LOCAL_TTS_PORT" server-side. Reading raw bytes and decoding them
#   ourselves (rather than through Get-Content) preserves the BOM
#   character, so it blocks the match here exactly like it blocks the
#   server's own key lookup (.NET regex `\s` does NOT match U+FEFF, unlike
#   JS regex `\s` — measured directly).
# - #2632 N52 — inline comments: process.loadEnvFile strips an unquoted
#   value's trailing `#...` comment and trims the result (measured:
#   `PORT=9011 # x` and even `PORT=9011#x` both resolve process.env.PORT to
#   "9011"). A match that requires the captured token to run to
#   end-of-line (no trailing comment) fails to match a commented
#   duplicate's LAST line at all, silently falling back to an EARLIER
#   value the server has already overwritten.
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
        # Raw bytes decoded by hand (never Get-Content) so a leading BOM
        # survives into $raw exactly as process.loadEnvFile sees it.
        $bytes = [System.IO.File]::ReadAllBytes($EnvPath)
        $raw = [System.Text.Encoding]::UTF8.GetString($bytes)
    } catch {
        return $null
    }
    $lines = $raw -split "`r`n|`n|`r"
    $found = $null
    foreach ($line in $lines) {
        if ($line -match "^[ \t]*$Key[ \t]*=[ \t]*(.*)$") {
            $value = $Matches[1]
            $hashIndex = $value.IndexOf('#')
            if ($hashIndex -ge 0) { $value = $value.Substring(0, $hashIndex) }
            $found = $value.Trim()
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
# Vite-side sibling of Get-ConfiguredServerPort (#2632 N39), sharing ITS OWN
# reader's process.loadEnvFile-mirroring contract. That contract is THIS
# reader's only, not Vite's: vite.config.ts reads VITE_PORT itself via
# Vite's loadEnv (dotenv-based) plus a bare Number() — a different parser
# with different rules (no BOM handling, no digit-only gate, silently
# coerces spellings Get-LocalTtsPortValue rejects). Any divergence between
# the two readers fails safe (this one only decides what stop-app.ps1
# sweeps, never what Vite actually binds to), so no behaviour change
# follows from this being two separate parsers — noted here only so this
# reader isn't mistaken for Vite's own.
function Get-ConfiguredVitePort {
    [CmdletBinding()]
    param(
        [string] $EnvLocalPath
    )
    return Get-ConfiguredPortFromEnv -Key 'VITE_PORT' -EnvPath $EnvLocalPath
}

# Check if a process identified by its PID is still alive (process exists).
# Uses Get-Process with -ErrorAction SilentlyContinue to check for existence.
function Test-ProcessAlive {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int] $Pid
    )
    if ($Pid -le 0) { return $false }
    return $null -ne (Get-Process -Id $Pid -ErrorAction SilentlyContinue)
}

function Get-SidecarSweepPort {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $RunDir,
        [string] $ServerEnvPath
    )
    $noteFiles = @(Get-ChildItem -Path $RunDir -Filter 'tts.owner.*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -cmatch '^tts\.owner\.[0-9]+\.json$' })

    # Filter note files: read each one and keep only those with a live PID.
    $liveNotes = @()
    foreach ($noteFile in $noteFiles) {
        try {
            $note = Get-Content $noteFile.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
            if ($note.pid -is [int] -or $note.pid -is [long]) {
                $pid = [int]$note.pid
                if ($pid -gt 0 -and (Test-ProcessAlive -Pid $pid)) {
                    $liveNotes += $note
                }
            }
        } catch {
            # Unreadable, corrupt, or dead PID — skip this note.
        }
    }

    # Exactly one live note: use it.
    if ($liveNotes.Count -eq 1) {
        if ($liveNotes[0].port -is [int] -or $liveNotes[0].port -is [long] -or $liveNotes[0].port -is [double]) {
            $port = [int]$liveNotes[0].port
            if ($port -gt 0 -and $port -lt 65536) { return $port }
        }
    }
    # Zero live notes or more than one: ambiguous or absent — fall back to server\.env.
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
        [AllowEmptyCollection()]
        [int[]] $BasePorts,
        [Parameter(Mandatory)]
        [string] $RunDir,
        [string] $ServerEnvPath
    )
    $ttsPort = Get-SidecarSweepPort -RunDir $RunDir -ServerEnvPath $ServerEnvPath
    if ($ttsPort) { return @($BasePorts) + @($ttsPort) }
    return @($BasePorts)
}

# #2632 N53 — decide the final stop-summary line (or none), so stop-app.ps1
# stops unconditionally claiming "[OK] nothing to stop". Three distinct
# outcomes were being collapsed into one message:
# - a PID kill actually happened (KilledAny) — the per-item [STOP] lines
#   already said so, no summary needed;
# - the sweep found something it could not clear (SweepIncomplete: a
#   Stop-Process kill was denied) — claiming "nothing to stop" here is
#   false reassurance, and the [SWEEP] line above already reported it;
# - zero ports resolved for this checkout at all (Ports is empty) — this
#   means "nothing was CHECKED", not "checked and found clear", and must
#   read differently from the confirmed-clear case.
# Pulled out (mirrors Get-PortsToSweep) so this decision is itself
# unit-testable without spinning up real listeners/PIDs.
function Get-StopSummaryMessage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] [bool] $KilledAny,
        [Parameter(Mandatory)] [bool] $SweepIncomplete,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [int[]] $Ports
    )
    if ($KilledAny) { return $null }
    if ($SweepIncomplete) { return $null }
    if ($Ports.Count -eq 0) { return "[OK] nothing to stop (no ports resolved for this checkout)" }
    return "[OK] nothing to stop"
}

Export-ModuleMember -Function Get-SidecarSweepPort, Get-LocalTtsPortFromServerEnv, Get-PortsToSweep, Get-LocalTtsPortValue, Get-ConfiguredPortFromEnv, Get-ConfiguredServerPort, Get-ConfiguredVitePort, Get-StopSummaryMessage
