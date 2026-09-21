"""A24 phase 2b: saturate cuda:1 (ASR's pinned card) with a real allocation,
then fire /transcribe with the correct wire shape (raw int16 PCM body +
X-Sample-Rate header) and capture the sidecar's genuine noCapacity 503 while
health reports the design resident on cuda:0."""
import json
import struct
import subprocess
import sys
import time
import urllib.request

OUT = r"C:\Claude\Projects\wt-onbox-batch-1\docs\testing\onbox-mechanical-batch1-results\a24-capacity-device-scope-2026-09-21"
BASE = "http://127.0.0.1:9020"
VENV_PY = r"C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar\.venv\Scripts\python.exe"

# 1. start the file-based saturator as a detached child
sat = subprocess.Popen(
    [VENV_PY, OUT + r"\a24_saturator.py"],
    stdout=open(OUT + r"\saturator2.log", "w"), stderr=subprocess.STDOUT,
)

# 2. wait until the sidecar's OWN view of cuda:1 free memory drops (admission
#    reads NVML-style free memory, same as nvidia-smi)
def used_mb(idx):
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.used",
                          "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    for line in out.strip().splitlines():
        i, m = line.split(",")
        if int(i.strip()) == idx:
            return int(m.strip())
    return -1

deadline = time.time() + 90
while time.time() < deadline and used_mb(1) < 10000:
    time.sleep(3)
with open(OUT + r"\phase2b_gpu_state.json", "w") as f:
    json.dump({"cuda0_used_mb": used_mb(0), "cuda1_used_mb": used_mb(1),
               "saturation_child_alive": sat.poll() is None}, f, indent=2)

# 3. raw PCM POST /transcribe — 1 s of 16 kHz int16 silence
pcm = struct.pack("<16000h", *([0] * 16000))
req = urllib.request.Request(BASE + "/transcribe", data=pcm, method="POST",
                             headers={"Content-Type": "application/octet-stream",
                                      "X-Sample-Rate": "16000"})
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        res = {"http_status": r.status, "unexpected_body": r.read(400).decode(errors="replace")}
except urllib.error.HTTPError as e:
    res = {"http_status": e.code, "body": e.read().decode(errors="replace")[:2000]}
except Exception as e:
    res = {"error": repr(e)}
res["elapsed_s"] = round(time.time() - t0, 1)
with open(OUT + r"\phase2b_transcribe_response.json", "w") as f:
    json.dump(res, f, indent=2)

# 4. health at the moment of denial — the cross-device pairing
with urllib.request.urlopen(BASE + "/health", timeout=30) as r:
    h = json.load(r)
with open(OUT + r"\phase2b_health_at_denial.json", "w") as f:
    json.dump({"qwen_design_resident": h["qwen_design_resident"],
               "qwen_device_key": h["qwen_device_key"],
               "transcribe_denied_deviceKey": (res.get("body") or "?")}, f, indent=2)

sat.terminate()
