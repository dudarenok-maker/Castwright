$ErrorActionPreference = 'Continue'
# A33 launcher (Castwright#3314): worktree sidecar on :9037, all TTS engines pinned to GPU0.
$s = 'C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar'
$d = 'C:\Users\dudar\AppData\Local\Temp\open-engine-ringer\oe-heartbeat-cline-qwen-cloud-3314-20260923-101803\oe-heartbeat-cline-qwen-cloud'
$env:KOKORO_DEVICE = 'cuda:0'; $env:QWEN_DEVICE = 'cuda:0'; $env:COQUI_DEVICE = 'cuda:0'
Set-Location $s
& "$s\.venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 9037 1>>"$d\a33-out.log" 2>>"$d\a33-err.log"
