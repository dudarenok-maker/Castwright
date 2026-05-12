#requires -Version 5.1
# Stop everything started by start-app.ps1. Reads .run\*.pid, kills the
# whole process tree (taskkill /T — npm.cmd shims spawn node children),
# then sweeps any orphaned listeners on the three known ports.

$ErrorActionPreference = "Continue"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
$runDir = Join-Path $repoRoot ".run"

function Write-Status($msg) { try { Write-Host $msg } catch {} }

$names = @("frontend", "server", "tts")
$killedAny = $false

foreach ($name in $names) {
    $pidPath = Join-Path $runDir "$name.pid"
    if (-not (Test-Path $pidPath)) { continue }
    $raw = (Get-Content $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
    $procId = 0
    if (-not [int]::TryParse($raw, [ref]$procId)) { continue }
    # /T = tree, /F = force. Suppress output; we'll report ourselves.
    & taskkill /PID $procId /T /F *> $null
    if ($LASTEXITCODE -eq 0) {
        Write-Status "[STOP] $name pid=$procId"
        $killedAny = $true
    } else {
        Write-Status "[GONE] $name pid=$procId (already exited)"
    }
}

# Belt-and-braces: kill any orphaned listeners on our ports.
$ports = @(5173, 8080, 9000)
$conns = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue
if ($conns) {
    foreach ($c in $conns) {
        try {
            Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
            Write-Status "[SWEEP] killed pid=$($c.OwningProcess) on :$($c.LocalPort)"
            $killedAny = $true
        } catch {
            Write-Status "[SWEEP] could not kill pid=$($c.OwningProcess) on :$($c.LocalPort): $($_.Exception.Message)"
        }
    }
}

if (-not $killedAny) { Write-Status "[OK] nothing to stop" }
exit 0
