<#
.SYNOPSIS
  Launches `git commit` detached and hidden, for headless/OE agent lanes.

.DESCRIPTION
  Replaces the freelanced inline Start-Process snippets OE lanes have been
  writing per-run (documented in .clinerules/cline.md "commit detached"
  recipe). Two failure modes that recipe already warns against, and that a
  freelanced variant hit on 2026-08-26 (Castwright open-engine ticket #2659):
    - dropping `-WindowStyle Hidden`, which pops a visible PowerShell window
      for the commit itself AND for the husky pre-commit hook it triggers
    - reintroducing commit-message quoting bugs (unescaped `'` in the subject)
      by building the git command as an interpolated string

  Call this script directly with -Message as a bound parameter (never build
  a command string containing the message) so quoting is a non-issue: no
  escaping of apostrophes is needed by the caller.

.PARAMETER Worktree
  Absolute path to the worktree/checkout to commit in.

.PARAMETER Message
  Full commit message (subject, optionally with a blank line + body).

.OUTPUTS
  The scratch directory path (also written nowhere else) -- poll it per the
  "commit detached" recipe in .clinerules/cline.md:
    - alive:  Get-Process -Id (Get-Content "$T\commit.pid") -ErrorAction SilentlyContinue
    - done:   Test-Path "$T\commit.log" -and it contains a line starting "EXIT="
    - result: Get-Content "$T\commit.log" once done is true and alive is false

.EXAMPLE
  $T = & C:\Claude\Projects\wt-1994-qwen-duration-baseline\scripts\oe-detached-commit.ps1 `
         -Worktree 'C:\Claude\Projects\wt-1994-qwen-duration-baseline' `
         -Message "test(sidecar): add Qwen duration golden-audio baseline scaffold (#2659)"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Worktree,
    [Parameter(Mandatory)][string]$Message
)

$ErrorActionPreference = 'Stop'

$run = Get-Date -Format 'yyyyMMdd-HHmmss'
$T = Join-Path $env:TEMP "cw-commit-$run"
New-Item -ItemType Directory -Path $T -Force | Out-Null

# No BOM: PS 5.1's default utf8 write adds one, `git commit -F` does not
# strip it, and scripts/validate-commit-msg.mjs then rejects a subject that
# LOOKS fine (the BOM is invisible) -- after the whole verify battery has
# already paid.
[IO.File]::WriteAllText((Join-Path $T 'msg.txt'), $Message, (New-Object System.Text.UTF8Encoding $false))

# Paths come in via param() rather than string interpolation, so nothing
# about $Worktree or the scratch dir can reintroduce a quoting bug either.
$childScript = @'
param([string]$Dir, [string]$Worktree)
$ErrorActionPreference = 'Continue'
git -C $Worktree commit -F (Join-Path $Dir 'msg.txt') *>&1 |
  Out-File -FilePath (Join-Path $Dir 'commit.log') -Encoding utf8
"EXIT=$LASTEXITCODE" | Out-File -FilePath (Join-Path $Dir 'commit.log') -Append -Encoding utf8
'@
Set-Content -Path (Join-Path $T 'commit.ps1') -Value $childScript -Encoding utf8

# Clear the log FIRST: Start-Process returns before the child truncates it,
# so a poll against a stale file from a prior run in the same $T would
# report a verdict for a run that is still going. ($T is timestamped fresh
# above, so this is a defensive no-op today -- kept because a caller could
# reuse a $T.)
Remove-Item (Join-Path $T 'commit.log') -ErrorAction SilentlyContinue

# -WindowStyle Hidden is the whole point of this script: a freelanced
# Start-Process call that omits it pops a visible console for the commit
# AND for the husky pre-commit hook `git commit` triggers.
# -ArgumentList does NOT quote its elements, so each path arg is quoted here.
$p = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$T\commit.ps1`"",
    '-Dir', "`"$T`"", '-Worktree', "`"$Worktree`"")
$p.Id | Set-Content (Join-Path $T 'commit.pid')

Write-Output $T
