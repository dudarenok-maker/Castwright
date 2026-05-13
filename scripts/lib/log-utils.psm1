#requires -Version 5.1
# Shared log helpers for the start/stop scripts. Extracted into a module so
# Pester can exercise them without running the full startup sequence.

# Truncate a log so this run starts clean. If the file is locked — OneDrive
# holds recently-modified files open for cloud sync, AV scanners can do the
# same — rotate to a timestamped sibling and return that path instead so
# Start-Process redirection still succeeds.
function New-FreshLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Path
    )
    try {
        Set-Content -Path $Path -Value "" -Encoding utf8 -ErrorAction Stop
        return $Path
    } catch {
        $dir   = Split-Path -Parent $Path
        $base  = [System.IO.Path]::GetFileNameWithoutExtension($Path)
        $ext   = [System.IO.Path]::GetExtension($Path)
        $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
        $rotated = Join-Path $dir "$base.$stamp$ext"
        Set-Content -Path $rotated -Value "" -Encoding utf8
        return $rotated
    }
}

# Delete rotated `<name>.YYYYMMDD-HHMMSS.log` files older than MaxAgeDays.
# Canonical (untimestamped) logs like `tts.log` and `tts.err.log` are left
# alone regardless of age — only the timestamped siblings are pruned.
# Failures are swallowed: cleanup is best-effort and must not abort startup.
function Remove-OldRotatedLogs {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string] $Dir,
        [int]    $MaxAgeDays = 7
    )
    if (-not (Test-Path $Dir)) { return }
    $cutoff  = (Get-Date).AddDays(-$MaxAgeDays)
    $pattern = '\.\d{8}-\d{6}$'
    Get-ChildItem -Path $Dir -File -Filter "*.log" -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -match $pattern -and $_.LastWriteTime -lt $cutoff } |
        ForEach-Object {
            try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop }
            catch { }
        }
}

Export-ModuleMember -Function New-FreshLog, Remove-OldRotatedLogs
