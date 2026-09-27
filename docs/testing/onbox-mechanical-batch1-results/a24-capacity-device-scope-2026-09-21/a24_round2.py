"""A24 round 2 — deny /transcribe while the design is STILL resident.
Fit math from round 1: ASR 'base' needs ~409 MB and the device free-floor is
1024 MB, so saturation must leave cuda:1 with < ~1.4 GB free. Leaves ~150 MB."""
import json
import struct
import subprocess
import time
import urllib.request

OUT = r"C:\Claude\Projects\wt-onbox-batch-1\docs\testing\onbox-mechanical-batch1-results\a24-capacity-device-scope-2026-09-21"
BASE = "http://127.0.0.1:9020"
VENV_PY = r"C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar\.venv\Scripts\python.exe"

def write(name, obj):
    with open(OUT + "\\" + name, "w") as f:
        json.dump(obj, f, indent=2)

def http(method, path, data=None, headers=None, timeout=120):
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(2000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000)

def used_mb(idx):
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.used",
                          "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    for line in out.strip().splitlines():
        i, m = line.split(",")
        if int(i.strip()) == idx:
            return int(m.strip())
    return -1

t_start = time.time()

# 0. race guard: design must still be resident (it was reloaded 10:01:05,
#    watchdog evicts after 120 s idle)
st, resp = http("GET", "/health", timeout=15)
h = json.loads(resp)
write("r0_health_start.json", {"resident": h["qwen_design_resident"],
                               "key": h["qwen_device_key"], "asr_note": "round2"})
if not h["qwen_design_resident"]:
    write("r0_abort.json", {"reason": "design evicted before round 2 start"})
    raise SystemExit(2)

# 1. saturate deeper (hold = free - 150 MB)
sat = subprocess.Popen([VENV_PY, OUT + r"\a24_saturator.py", "150"],
                       stdout=open(OUT + r"\saturator4.log", "w"), stderr=subprocess.STDOUT)
deadline = time.time() + 75
while time.time() < deadline and used_mb(1) < 15900:
    time.sleep(2)
write("r1_saturation.json", {"cuda0_used_mb": used_mb(0), "cuda1_used_mb": used_mb(1),
                             "sat_alive": sat.poll() is None,
                             "t_after_start_s": round(time.time() - t_start, 1)})

# 2. deny /transcribe
pcm = struct.pack("<16000h", *([0] * 16000))
st, resp = http("POST", "/transcribe", pcm,
                {"Content-Type": "application/octet-stream", "X-Sample-Rate": "16000"})
write("r2_transcribe.json", {"status": st, "body": resp.decode(errors="replace"),
                             "t_after_start_s": round(time.time() - t_start, 1)})

# 3. health at denial
st, resp = http("GET", "/health", timeout=15)
h = json.loads(resp)
write("r3_health_at_denial.json", {"qwen_design_resident": h["qwen_design_resident"],
                                   "qwen_device_key": h["qwen_device_key"],
                                   "t_after_start_s": round(time.time() - t_start, 1)})
sat.terminate()
