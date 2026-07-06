#requires -Version 5.1
# Holds the system awake (Modern Standby suppressed, display left alone) for
# as long as this process is alive. The server (server/src/system/prevent-
# sleep.ts) spawns this for the duration of an active generation and kills
# the process once the queue goes idle — Windows automatically resets the
# execution-state flag when the holding thread exits, so no explicit
# release call is needed on the way out.

Import-Module (Join-Path $PSScriptRoot 'prevent-sleep.psm1') -Force

if (-not (Set-SystemAwake)) {
    Write-Error 'SetThreadExecutionState failed -- sleep prevention not active.'
    exit 1
}

# Re-assert periodically in case something else resets the flag, and keep
# this process alive so ES_CONTINUOUS holds until the server kills it.
while ($true) {
    Start-Sleep -Seconds 30
    Set-SystemAwake | Out-Null
}
