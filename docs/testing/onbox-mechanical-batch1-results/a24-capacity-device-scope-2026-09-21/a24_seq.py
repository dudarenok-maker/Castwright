"""A24 full sequence, race-safe:
 T0   launch a detached driver:
      1. /qwen/design-voice (cold, ~70 s) -> design resident on cuda:0
      2. start saturator child (~40 s of cuda:1 VRAM hold)
      3. before the 120 s design-idle watchdog fires: raw-PCM /transcribe
         (ASR pinned cuda:1) -> expect genuine noCapacity 503 deviceKey
         'cuda:1' WHILE health reports qwen_design_resident=true,
         qwen_device_key='cuda:0'."""
import json
import struct
import subprocess
import threading
import time
import urllib.request

OUT = r"C:\Claude\Projects\wt-onbox-batch-1\docs\testing\onbox-mechanical-batch1-results\a24-capacity-device-scope-2026-09-21"
BASE = "http://127.0.0.1:9020"
VENV_PY = r"C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar\.venv\Scripts\python.exe"

def write(name, obj):
    with open(OUT + "\\" + name, "w") as f:
        json.dump(obj, f, indent=2)

def http(method, path, data=None, headers=None, timeout=900):
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(2000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000)

def used_mb(idx):
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.used",
                          "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout
    for line in out.strip().splitlines():
        i, m = line.split(",")
        if int(i.strip()) == idx:
            return int(m.strip())
    return -1

# 1. arm the design (long, blocking for this driver process)
body = json.dumps({"voiceId": "a24probe-2026-09-21",
                   "instruct": "a calm, low, unhurried documentary narrator"}).encode()
t0 = time.time()
st, resp = http("POST", "/qwen/design-voice", body, {"Content-Type": "application/json"})
write("seq1_design.json", {"status": st, "elapsed_s": round(time.time() - t0, 1),
                           "body_head": resp[:200].decode(errors="replace")})
if st != 200:
    raise SystemExit(1)

# 2. saturate cuda:1 (child process; ~30-45 s for torch import + big alloc)
#    leave only 150 MB free — ASR 'base' needs ~409 MB, so admission MUST deny
sat = subprocess.Popen([VENV_PY, OUT + r"\a24_saturator.py", "150"],
                       stdout=open(OUT + r"\saturator3.log", "w"),
                       stderr=subprocess.STDOUT)
# watchdog race guard: bail if we're past ~100 s since design finished
deadline = time.time() + 100
while time.time() < deadline and used_mb(1) < 16100:
    time.sleep(2)
write("seq2_saturation.json", {"cuda0_used_mb": used_mb(0), "cuda1_used_mb": used_mb(1),
                               "sat_child_alive": sat.poll() is None})

# 3. deny /transcribe (pinned cuda:1) BEFORE the 120 s design TTL
pcm = struct.pack("<16000h", *([0] * 16000))
st, resp = http("POST", "/transcribe", pcm,
                {"Content-Type": "application/octet-stream",
                 "X-Sample-Rate": "16000"}, timeout=120)
write("seq3_transcribe.json", {"status": st, "body": resp.decode(errors="replace")})

# 4. health at denial — the cross-device pairing artifact
st, resp = http("GET", "/health", timeout=30)
h = json.loads(resp)
write("seq4_health_at_denial.json", {"qwen_design_resident": h["qwen_design_resident"],
                                     "qwen_device_key": h["qwen_device_key"],
                                     "qwen_loaded": h["qwen_loaded"]})
sat.terminate()
