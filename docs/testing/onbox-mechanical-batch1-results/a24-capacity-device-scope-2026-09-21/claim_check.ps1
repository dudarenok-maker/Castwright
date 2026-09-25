$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 1) decode the UTF-16 comment dump captured earlier
$raw = Get-Content (Join-Path $dir 'issue3299_comments.json') -Raw
$m = [regex]::Matches($raw, 'AGENT (RESUMED|DONE)[^"]{0,120}')
"--- local dump: agent markers (last 8) ---"
$m | Select-Object -Last 8 | ForEach-Object { $_.Value }
# 2) live: issue state + last comments + claim markers
"--- live issue state ---"
(gh api repos/dudarenok-maker/Castwright/issues/3299 --jq '.state') 2>&1
"--- live comments: agent markers ---"
$all = gh api repos/dudarenok-maker/Castwright/issues/3299/comments 2>&1 | Out-String
$allm = [regex]::Matches($all, 'AGENT (RESUMED|DONE)[^"]{0,120}')
$allm | Select-Object -Last 10 | ForEach-Object { $_.Value }
"--- done ---"
