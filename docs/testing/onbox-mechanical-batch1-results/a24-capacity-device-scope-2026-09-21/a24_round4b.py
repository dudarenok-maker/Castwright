"""A24 round 4b — design (cuda:0) and 2 GB filler already live. Add a second
filler to bring cuda:1 free below ASR's ~409 MB need, deny /transcribe, then
snapshot health while the design is still resident."""
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

# race guard
st, resp = http("GET", "/health", timeout=15)
h = json.loads(resp)
if not h["qwen_design_resident"]:
    write("r4b_abort.json", {"reason": "design evicted before 4b", "key": h["qwen_device_key"]})
    raise SystemExit(2)

fill = subprocess.Popen([VENV_PY, OUT + r"\a24_filler.py", "12400"],
                        stdout=open(OUT + r"\filler2.log", "w"), stderr=subprocess.STDOUT)
deadline = time.time() + 45
while time.time() < deadline and used_mb(1) < 12300:
    time.sleep(2)
write("r4b_saturation.json", {"cuda0_used_mb": used_mb(0), "cuda1_used_mb": used_mb(1),
                              "fill_child_alive": fill.poll() is None})

pcm = struct.pack("<16000h", *([0] * 16000))
t0 = time.time()
st, resp = http("POST", "/transcribe", pcm,
                {"Content-Type": "application/octet-stream", "X-Sample-Rate": "16000"})
write("r4b_transcribe.json", {"status": st, "body": resp.decode(errors="replace"),
                              "elapsed_s": round(time.time() - t0, 1)})

st, resp = http("GET", "/health", timeout=15)
h = json.loads(resp)
write("r4b_health_at_denial.json", {"qwen_design_resident": h["qwen_design_resident"],
                                    "qwen_device_key": h["qwen_device_key"]})
fill.terminate()
