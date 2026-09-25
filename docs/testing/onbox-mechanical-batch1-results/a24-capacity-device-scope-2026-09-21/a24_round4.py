"""A24 round 4 — saturation child owns the SIDE of the buffer allocation
(e.g. `python a24_filler.py 2048`) so torch's context headroom can never
absorb it. Then /transcribe must hit a genuine noCapacity on cuda:1 while
the design is resident on cuda:0."""
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
# 1. arm the design (fresh sidecar => room; ~66 s)
body = json.dumps({"voiceId": "a24probe2-2026-09-21",
                   "instruct": "a warm, measured audiobook narrator"}).encode()
st, resp = http("POST", "/qwen/design-voice", body, {"Content-Type": "application/json"}, timeout=300)
t_design_done = time.time()
write("r4_design.json", {"status": st, "elapsed_s": round(t_design_done - t_start, 1)})
if st != 200:
    write("r4_abort.json", {"reason": "design not 200", "status": st,
                            "body": resp.decode(errors="replace")[:500]})
    raise SystemExit(1)

# 2. fill cuda:1 down to ~1.0 GB free (2048 MB chunk, owned by this child)
fill_mb = 2048
sat = subprocess.Popen([VENV_PY, OUT + r"\a24_filler.py", str(fill_mb)],
                       stdout=open(OUT + r"\filler.log", "w"), stderr=subprocess.STDOUT)
deadline = t_design_done + 95
while time.time() < deadline and used_mb(1) < 14300:
    time.sleep(2)
write("r4_saturation.json", {"cuda0_used_mb": used_mb(0), "cuda1_used_mb": used_mb(1),
                             "fill_child_alive": sat.poll() is None,
                             "t_after_design_s": round(time.time() - t_design_done, 1)})

# 3. deny /transcribe
pcm = struct.pack("<16000h", *([0] * 16000))
st, resp = http("POST", "/transcribe", pcm,
                {"Content-Type": "application/octet-stream", "X-Sample-Rate": "16000"})
write("r4_transcribe.json", {"status": st, "body": resp.decode(errors="replace"),
                             "t_after_design_s": round(time.time() - t_design_done, 1)})

# 4. health at denial
st, resp = http("GET", "/health", timeout=15)
h = json.loads(resp)
write("r4_health_at_denial.json", {"qwen_design_resident": h["qwen_design_resident"],
                                   "qwen_device_key": h["qwen_device_key"],
                                   "qwen_loaded": h["qwen_loaded"]})
sat.terminate()
