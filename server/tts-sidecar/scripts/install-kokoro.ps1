# install-kokoro.ps1 -- download the Kokoro v1 ONNX model + voices manifest
# into ./voices/kokoro/ so the sidecar can preload them on boot.
#
# Idempotent: re-runs skip files that already exist with a non-zero size.
# Failure-tolerant: a half-finished download is removed so the next run
# retries cleanly. No external dependencies -- pure Invoke-WebRequest.
#
# ASCII-only per repo convention (Windows PowerShell 5.1 reads UTF-8
# without BOM as Win-1252 and mojibakes em-dashes/smart-quotes).

[CmdletBinding()]
param(
    [string]$ModelUrl   = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx',
    [string]$VoicesUrl  = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin',
    [string]$TargetDir  = ''
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) {
    Write-Host "[install-kokoro] $msg"
}

# Resolve the script directory at runtime. PSScriptRoot is the documented
# way but it doesn't reliably bind inside param() defaults under PS 5.1
# when the script is invoked via a nested `powershell -File` child --
# evaluating it in the body sidesteps that.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) {
    # Last-resort fallback for very unusual invocations (e.g. piped via
    # stdin). Use the current dir; user is expected to be in the script dir.
    $ScriptDir = (Get-Location).Path
}

if (-not $TargetDir) {
    $TargetDir = Join-Path $ScriptDir '..\voices\kokoro'
}

# Normalise target dir to an absolute path so the success log reads sanely.
$parent = Split-Path -Parent $TargetDir
if (Test-Path -LiteralPath $parent) {
    $TargetDir = Join-Path (Resolve-Path -LiteralPath $parent).Path (Split-Path -Leaf $TargetDir)
}

if (-not (Test-Path -LiteralPath $TargetDir)) {
    Write-Step "Creating $TargetDir"
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
}

# ops-7 (#430) -- pinned-hash integrity. The manifest sits next to this script.
$ManifestPath = Join-Path $ScriptDir 'model-hashes.json'

function Get-PinnedHash([string]$FileName) {
    if (-not (Test-Path -LiteralPath $ManifestPath)) { return $null }
    try {
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        $entry = $manifest.kokoro.$FileName
        if ($entry -and $entry.sha256) { return ([string]$entry.sha256).ToLower() }
    }
    catch { }
    return $null
}

# True if the file matches its pinned SHA256 (or is unpinned -- accept).
function Test-HashOk([string]$Dest) {
    $expected = Get-PinnedHash (Split-Path -Leaf $Dest)
    if (-not $expected) { return $true }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Dest).Hash.ToLower()
    return ($actual -eq $expected)
}

function Get-File([string]$Url, [string]$Dest) {
    if (Test-Path -LiteralPath $Dest) {
        $size = (Get-Item -LiteralPath $Dest).Length
        if ($size -gt 0) {
            if (Test-HashOk $Dest) {
                Write-Step "Skipping $(Split-Path -Leaf $Dest) -- already present and verified ($([math]::Round($size/1MB,1)) MB)."
                return
            }
            Write-Step "Cached $(Split-Path -Leaf $Dest) failed its integrity check -- re-downloading."
        }
        # Zero-byte (failed run) OR a hash mismatch -- delete and retry.
        Remove-Item -LiteralPath $Dest -Force
    }
    Write-Step "Downloading $(Split-Path -Leaf $Dest) from $Url"
    # Use TLS 1.2 explicitly -- PS 5.1 defaults to SSL3/TLS1 which GitHub
    # releases now reject. UseBasicParsing dodges IE engine dependency.
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
    }
    catch {
        # Wipe partial file so the next run retries cleanly rather than
        # claiming the cached zero-byte file is good.
        if (Test-Path -LiteralPath $Dest) {
            Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
        }
        throw
    }
    $size = (Get-Item -LiteralPath $Dest).Length
    if ($size -lt 1024) {
        Remove-Item -LiteralPath $Dest -Force
        throw "Downloaded $Dest is only $size bytes -- looks like an error page, not the real weights."
    }
    # ops-7 -- refuse + delete on a SHA256 mismatch so a corrupted/tampered
    # download never reaches the sidecar.
    if (-not (Test-HashOk $Dest)) {
        $expected = Get-PinnedHash (Split-Path -Leaf $Dest)
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Dest).Hash.ToLower()
        Remove-Item -LiteralPath $Dest -Force
        throw "Integrity check FAILED for $(Split-Path -Leaf $Dest). Expected SHA256 $expected but got $actual. Deleted the file -- re-run to retry, or re-bless model-hashes.json if the upstream asset legitimately changed."
    }
    Write-Step "Downloaded and verified $(Split-Path -Leaf $Dest) ($([math]::Round($size/1MB,1)) MB)"
}

Get-File -Url $ModelUrl  -Dest (Join-Path $TargetDir 'kokoro-v1.0.onnx')
Get-File -Url $VoicesUrl -Dest (Join-Path $TargetDir 'voices-v1.0.bin')

Write-Step 'Done. Restart the sidecar to pick up the new weights.'
