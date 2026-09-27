$ErrorActionPreference = 'Continue'
$d = 'C:\Users\dudar\AppData\Local\Temp\open-engine-ringer\oe-heartbeat-cline-qwen-cloud-3314-20260923-101803\oe-heartbeat-cline-qwen-cloud'
$log = "$d\a33-loadneg.log"
function Step($msg) { "$(Get-Date -Format 'HH:mm:ss') $msg" | Out-File -Append -Encoding utf8 $log }
Step "LOADNEG START"
try {
  $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:9037/load' -ContentType 'application/json' -Body '{"engine":"kokoro"}' -TimeoutSec 240
  Step "LOAD kokoro -> $($r | ConvertTo-Json -Compress)"
} catch { Step "LOAD ERR $($_.Exception.Message)" }
try {
  $h = Invoke-RestMethod 'http://127.0.0.1:9037/health' -TimeoutSec 15
  $h | ConvertTo-Json -Depth 9 | Out-File -Encoding utf8 "$d\a33-health-N2-loadneg.json"
  $unk = ($h.gpus | Where-Object { $_.idx -eq -1 }).resident | Where-Object { $_.engine -eq 'kokoro' }
  Step "VERDICT: devkok=$($h.devices.kokoro) loaded=$($h.kokoro_loaded) entry.actual_card=[$($unk.actual_card)] entry.stale=[$($unk.stale_reason)] cuda_verified=[$($h.cuda_verified)]"
} catch { Step "HEALTH ERR $($_.Exception.Message)" }
Step "LOADNEG-DONE"
