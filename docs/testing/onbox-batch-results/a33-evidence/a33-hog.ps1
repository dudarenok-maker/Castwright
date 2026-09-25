$ErrorActionPreference = 'Continue'
$d = 'C:\Users\dudar\AppData\Local\Temp\open-engine-ringer\oe-heartbeat-cline-qwen-cloud-3314-20260923-101803\oe-heartbeat-cline-qwen-cloud'
$py = 'C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar\.venv\Scripts\python.exe'
Set-Content -Path "$d\a33-hog-pid.txt" -Value $PID
& $py -c "import torch,time; t=torch.empty(2000*1024*1024, dtype=torch.uint8, device='cuda:0'); torch.cuda.synchronize(); time.sleep(1500)" 2>>"$d\a33-hogerr.log"
