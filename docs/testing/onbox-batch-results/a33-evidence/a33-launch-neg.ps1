$ErrorActionPreference = 'Continue'
# A33 negctrl launcher: NO device pins (auto intent), CUDA hidden from the process (CPU-only box shape).
$s = 'C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar'
$d = 'C:\Users\dudar\AppData\Local\Temp\open-engine-ringer\oe-heartbeat-cline-qwen-cloud-3314-20260923-101803\oe-heartbeat-cline-qwen-cloud'
Remove-Item Env:KOKORO_DEVICE -ErrorAction SilentlyContinue
Remove-Item Env:QWEN_DEVICE -ErrorAction SilentlyContinue
Remove-Item Env:COQUI_DEVICE -ErrorAction SilentlyContinue
$env:CUDA_VISIBLE_DEVICES = ''
Set-Location $s
& "$s\.venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 9037 1>>"$d\a33-out-neg.log" 2>>"$d\a33-err-neg.log"
