$ErrorActionPreference = 'Continue'
$d = 'C:\Users\dudar\AppData\Local\Temp\open-engine-ringer\oe-heartbeat-cline-qwen-cloud-3314-20260923-101803\oe-heartbeat-cline-qwen-cloud'
$log = "$d\a33-warm.log"
function Step($msg) { "$(Get-Date -Format 'HH:mm:ss') $msg" | Out-File -Append -Encoding utf8 $log }
Step "WARMTEST START"
$body = '{"engine":"kokoro","model":"kokoro-v1.0","voice":"af_heart","text":"The quick brown fox jumps over the lazy dog."}'
$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  Invoke-WebRequest -Method Post -Uri 'http://127.0.0.1:9037/synthesize' -ContentType 'application/json' -Body $body -OutFile "$d\a33-warm-synth.wav" -TimeoutSec 120 | Out-Null
  $sw.Stop()
  Step "WARM status=OK wall_ms=$($sw.ElapsedMilliseconds) bytes=$((Get-Item "$d\a33-warm-synth.wav").Length)"
} catch { $sw.Stop(); Step "WARM ERR after_ms=$($sw.ElapsedMilliseconds) $($_.Exception.Message)" }
$h = Invoke-RestMethod 'http://127.0.0.1:9037/health' -TimeoutSec 15
$unk = ($h.gpus | Where-Object { $_.idx -eq -1 }).resident | Where-Object { $_.engine -eq 'kokoro' }
Step "VERDICT: devkok=$($h.devices.kokoro) cuda_verified=$($h.cuda_verified) stale=[$($unk.stale_reason)] vram_by_dev=$($h.vram_reserved_mb_by_device.'cuda:0'.reserved_mb)"
$h | ConvertTo-Json -Depth 9 | Out-File -Encoding utf8 "$d\a33-health-N3-warm.json"
Step "WARMTEST-DONE"
