$ErrorActionPreference = 'Continue'
$out = 'C:\Claude\Projects\wt-onbox-batch-1\docs\testing\onbox-mechanical-batch1-results\a24-capacity-device-scope-2026-09-21'
gh api repos/dudarenok-maker/Castwright/issues/3299/comments > "$out\issue3299_comments.json"
$labels = gh api repos/dudarenok-maker/Castwright/issues/3299 --jq .labels
Write-Output "LABELS_RAW=$labels"
$c = Get-Content "$out\issue3299_comments.json" -Raw | ConvertFrom-Json
Write-Output ("COMMENT_COUNT=" + $c.Count)
foreach ($m in ($c | Select-Object -Last 8)) {
  $body = $m.body -replace "`r?`n", " "
  if ($body.Length -gt 180) { $body = $body.Substring(0,180) }
  Write-Output ($m.user.login + " [" + $m.created_at + "] :: " + $body)
}
