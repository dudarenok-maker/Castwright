<#
.SYNOPSIS
  Launches `git commit` detached and hidden, for headless/OE agent lanes.

.DESCRIPTION
  Replaces the freelanced inline Start-Process snippets OE lanes have been
  writing per-run (documented in .clinerules/cline.md "commit detached"
  recipe). Failure modes that recipe already warns against, and that
  freelanced variants hit on 2026-08-26 (Castwright open-engine ticket #2659)
  and in review of this very script (PR #2662):
    - dropping `-WindowStyle Hidden`, which pops a visible PowerShell window
      for the commit itself AND for the husky pre-commit hook it triggers
    - reintroducing commit-message quoting bugs (unescaped `'` in the subject)
      by building the git command as an interpolated string
    - a trailing backslash on a quoted path argument escaping the closing
      quote instead of terminating the path (Win32 argv quoting: a backslash
      run immediately before a `"` is only literal if doubled)
    - a same-second scratch dir colliding between two concurrently-launched
      commits and silently mixing up which message lands where

  Call this script directly with -Message as a bound parameter (never build
  a command string containing the message) so quoting is a non-issue: no
  escaping of apostrophes is needed by the caller.

.PARAMETER Worktree
  Absolute path to the worktree/checkout to commit in. A trailing backslash
  is tolerated (stripped before quoting) -- it would otherwise escape the
  closing quote in the launched command line.

.PARAMETER Message
  Full commit message (subject, optionally with a blank line + body).

.OUTPUTS
  The scratch directory path (also written nowhere else) -- poll it per the
  "commit detached" recipe in .clinerules/cline.md:
    - alive:  Get-Process -Id (Get-Content "$T\commit.pid") -ErrorAction SilentlyContinue
    - done:   Test-Path "$T\commit.log" -and it contains a line starting "EXIT="
    - result: Get-Content "$T\commit.log" once done is true and alive is false

.EXAMPLE
  $W = 'C:\Claude\Projects\wt-1994-qwen-duration-baseline'
  $T = & "$W\scripts\oe-detached-commit.ps1" -Worktree $W `
         -Message "test(sidecar): add Qwen duration golden-audio baseline scaffold (#2659)"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Worktree,
    [Parameter(Mandatory)][string]$Message
)

$ErrorActionPreference = 'Stop'

# Strip a trailing backslash: a quoted "...\" argument has its closing quote
# escaped by the preceding backslash under Win32 argv parsing, which folds
# the rest of the command line into this one argument instead of ending it.
$Worktree = $Worktree.TrimEnd('\')

# GUID-suffixed, not just second-resolution timestamped: two lanes launching
# in the same second (the normal case for parallel worktree lanes, which is
# the intended usage of this script) would otherwise collide on one scratch
# dir and each poll the other's commit -- reporting EXIT=0 for a commit that
# is not theirs, with no error at all.
$run = Get-Date -Format 'yyyyMMdd-HHmmss'
$T = Join-Path ([System.IO.Path]::GetTempPath()) "cw-commit-$run-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Path $T -Force | Out-Null

# No BOM: PS 5.1's default utf8 write adds one, `git commit -F` does not
# strip it, and scripts/validate-commit-msg.mjs then rejects a subject that
# LOOKS fine (the BOM is invisible) -- after the whole verify battery has
# already paid.
[IO.File]::WriteAllText((Join-Path $T 'msg.txt'), $Message, (New-Object System.Text.UTF8Encoding $false))

# Paths come in via param() rather than string interpolation, so nothing
# about $Worktree or the scratch dir can reintroduce a quoting bug in the
# CHILD script's own source (it never contains a literal path or message).
$childScript = @'
param([string]$Dir, [string]$Worktree)
$ErrorActionPreference = 'Continue'
git -C $Worktree commit -F (Join-Path $Dir 'msg.txt') *>&1 |
  Out-File -FilePath (Join-Path $Dir 'commit.log') -Encoding utf8
"EXIT=$LASTEXITCODE" | Out-File -FilePath (Join-Path $Dir 'commit.log') -Append -Encoding utf8
'@
Set-Content -Path (Join-Path $T 'commit.ps1') -Value $childScript -Encoding utf8

# Win32 argv quoting: -ArgumentList does NOT quote its elements, and a naive
# `"`"$Value`""` wrap breaks the instant $Value ends in a backslash (the
# backslash-quote pair is read as an escaped quote, not path-then-terminator).
# $Worktree is already stripped above; double any trailing backslash here so
# the rule applies uniformly to every path this script quotes.
function ConvertTo-QuotedArg([string]$Value) {
    if ($Value.EndsWith('\')) { $Value += '\' }
    return '"' + $Value + '"'
}

# -WindowStyle Hidden is the whole point of this script: a freelanced
# Start-Process call that omits it pops a visible console for the commit
# AND for the husky pre-commit hook `git commit` triggers.
$p = Start-Process powershell -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (ConvertTo-QuotedArg (Join-Path $T 'commit.ps1')),
    '-Dir', (ConvertTo-QuotedArg $T), '-Worktree', (ConvertTo-QuotedArg $Worktree))
$p.Id | Set-Content (Join-Path $T 'commit.pid')

Write-Output $T
