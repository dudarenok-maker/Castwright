$ErrorActionPreference = 'Continue'
$d = 'C:\Users\dudar\AppData\Local\Temp\open-engine-ringer\oe-heartbeat-cline-qwen-cloud-3314-20260923-101803\oe-heartbeat-cline-qwen-cloud'
$log = "$d\a33-b2.log"
$cls = ([wmiclass]'Win32_Process')
function Step($msg) { "$(Get-Date -Format 'HH:mm:ss') $msg" | Out-File -Append -Encoding utf8 $log }
function Load($body) { try { $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:9037/load' -ContentType 'application/json' -Body $body -TimeoutSec 600; return ($r | ConvertTo-Json -Compress) } catch { $resp = $_.Exception.Response; if ($resp) { try { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); return "HTTPERR " + [int]$resp.StatusCode + " " + $sr.ReadToEnd() } catch {} }; return "ERR " + $_.Exception.Message } }
function Unload($body) { try { $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:9037/unload' -ContentType 'application/json' -Body $body -TimeoutSec 120; return ($r | ConvertTo-Json -Compress) } catch { return "ERR " + $_.Exception.Message } }
function Health { Invoke-RestMethod 'http://127.0.0.1:9037/health' -TimeoutSec 15 }
function Snap($name) {
  $h = Health
  $h | ConvertTo-Json -Depth 9 | Out-File -Encoding utf8 "$d\a33-health-$name.json"
  $unk = ($h.gpus | Where-Object { $_.idx -eq -1 }).resident | ForEach-Object { $_.engine + '/' + $_.actual_card + '/' + $_.stale_reason }
  $res0 = ($h.gpus[0].resident | ForEach-Object { $_.engine + '@' + $_.actual_card }) -join ','
  Step "SNAP $name : kokoro=$($h.kokoro_loaded) devkok=$($h.devices.kokoro) g0free=$($h.gpus[0].free_mb) g0res=[$res0] unk=[$($unk -join ',')] cuda_verified=$($h.cuda_verified) committed=$($h.committed_mb)"
  return $h
}
Step "B2 PHASE START (fresh sidecar)"
$ok = $false
for ($i = 0; $i -lt 40; $i++) { try { if ((Health).ok) { $ok = $true; break } } catch {}; Start-Sleep 5 }
if (-not $ok) { Step "SIDECAR NEVER CAME UP - ABORT"; exit 1 }
Snap 'H0-baseline' | Out-Null
Load '{"engine":"qwen"}' | ForEach-Object { Step "LOAD qwen -> $_" }
for ($i = 0; $i -lt 60; $i++) { $h = Health; if ($h.qwen_loaded -and -not $h.qwen_loading) { break }; Start-Sleep 5 }
Snap 'H1-qwen' | Out-Null
Load '{"engine":"coqui"}' | ForEach-Object { Step "LOAD coqui -> $_" }
Snap 'H2-coqui' | Out-Null
$r = $cls.Create("powershell -NoProfile -ExecutionPolicy Bypass -File $d\a33-hog.ps1")
Step "HOG spawned PID=$($r.ProcessId) RC=$($r.ReturnValue)"
$hogged = $false
for ($i = 0; $i -lt 24; $i++) { Start-Sleep 5; $h = Health; if ($h.gpus[0].free_mb -lt 1500) { $hogged = $true; break } }
Step "hog effective=$hogged free0=$((Health).gpus[0].free_mb)"
Snap 'H3-hog' | Out-Null
Load '{"engine":"kokoro"}' | ForEach-Object { Step "LOAD kokoro (contended) -> $_" }
$h = Snap 'H4-b2-admission'
$unk = ($h.gpus | Where-Object { $_.idx -eq -1 }).resident | Where-Object { $_.engine -eq 'kokoro' }
Step "VERDICT: devices.kokoro=$($h.devices.kokoro) entry.actual_card=$($unk.actual_card) entry.stale_reason=[$($unk.stale_reason)] kokoro_loaded=$($h.kokoro_loaded)"
Unload '{"engine":"kokoro"}' | ForEach-Object { Step "UNLOAD kokoro -> $_" }
Snap 'H5-after-unload' | Out-Null
$hp = (Get-Content "$d\a33-hog-pid.txt" -ErrorAction SilentlyContinue)
if ($hp) { Get-WmiObject Win32_Process -Filter "ProcessId=$hp" | ForEach-Object { $_.Terminate() | Out-Null; Step "HOG killed PID=$hp" } }
Step "B2-DONE"
