#requires -Version 5.1
# Win32 sleep-prevention helpers. Extracted into a module so Pester can
# exercise the SetThreadExecutionState call directly, without running the
# keep-alive loop in prevent-sleep.ps1.

if (-not ([System.Management.Automation.PSTypeName]'Native.Power').Type) {
    Add-Type -Namespace Native -Name Power -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
}

# 0x80000000 as a hex literal parses as a signed Int32 (-2147483648) in
# Windows PowerShell 5.1, which then fails a direct [uint32] cast (out of
# range) — use the equivalent unsigned decimal literal instead.
$script:ES_CONTINUOUS = [uint32]2147483648
$script:ES_SYSTEM_REQUIRED = [uint32]1

# Assert ES_SYSTEM_REQUIRED so Windows won't enter Modern Standby / sleep
# while the calling process stays alive. Deliberately omits
# ES_DISPLAY_REQUIRED — the display is left to dim/turn off on its own normal
# timeout; only system sleep is suppressed. Returns $true on success, $false
# if the Win32 call failed (SetThreadExecutionState returns 0 on failure).
function Set-SystemAwake {
    [CmdletBinding()]
    param()
    $result = [Native.Power]::SetThreadExecutionState($script:ES_CONTINUOUS -bor $script:ES_SYSTEM_REQUIRED)
    return ($result -ne 0)
}

# Release the ES_SYSTEM_REQUIRED hold (back to ES_CONTINUOUS only) without
# waiting for process exit. Windows also does this automatically once the
# holding thread/process terminates, so callers don't strictly need to call
# this before exiting — it's here mainly so tests can clean up in-process.
function Reset-SystemAwake {
    [CmdletBinding()]
    param()
    $result = [Native.Power]::SetThreadExecutionState($script:ES_CONTINUOUS)
    return ($result -ne 0)
}

Export-ModuleMember -Function Set-SystemAwake, Reset-SystemAwake
