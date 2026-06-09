# Restart-policy decision for the sidecar supervisor loop in start.ps1.
#
# Extracted into its own dot-sourceable file so it can be unit-tested
# (start.ps1 boots uvicorn on load and can't be dot-sourced). Tests live in
# scripts\tests\sidecar-restart-policy.Tests.ps1.
#
# ASCII-only by design: Windows PowerShell 5.1 reads UTF-8-without-BOM as
# Windows-1252 and mojibakes non-ASCII bytes, breaking the parser. Keep this
# file plain ASCII (same hazard called out in start.ps1).

function Test-SidecarShouldRestart {
    <#
    .SYNOPSIS
      Should the supervisor relaunch uvicorn for this sidecar self-exit code?
    .DESCRIPTION
      main.py self-exits with one of two recoverable codes:
        42 = CUDA poison. A device-side assert corrupts the CUDA context for
             the lifetime of the process; only a fresh Python interpreter
             recovers.
        43 = planned recycle. The memory watchdog self-exits when committed-
             private RAM or reserved VRAM crosses the configured ceiling, so a
             fresh process resets the leaked/spilled pool. This is REQUESTED
             recycling, not a crash -- it must relaunch.
      Any other code breaks the supervisor loop so a real bug (0 normal
      shutdown, 1 import/syntax error, 130 Ctrl+C, etc.) can't trap the
      supervisor in a tight respawn cycle.
    #>
    param([Parameter(Mandatory = $true)][int] $ExitCode)
    return ($ExitCode -eq 42) -or ($ExitCode -eq 43)
}
