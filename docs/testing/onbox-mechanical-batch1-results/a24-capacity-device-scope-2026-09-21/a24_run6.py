"""A24 FINAL run 6 — calibrated from rounds 1-5:
 * ASR 'base' (int8) needs ~409 MB and admission passes iff free(1) >= ~409
   (no floor applied at admission; round 1 passed with 795 MB free, round 5
   passed with ~3.4 GB free), so the filler must leave < 400 MB free.
 * total(1) = 16303, sidecar ctx ~197 => fill target 15700 leaves ~400.
 * filler needs ~15 s (torch import warm); design TTL 120 s after 200.
"""
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

# 1. design on fresh sidecar
body = json.dumps({"voiceId": "a24final6-2026-09-21",
                   "instruct": "a steady, friendly tutorial narrator"}).encode()
t0 = time.time()
st, resp = http("POST", "/qwen/design-voice", body, {"Content-Type": "application/json"}, timeout=300)
t_design = time.time()
write("s6_1_design.json", {"status": st, "elapsed_s": round(t_design - t0, 1)})
if st != 200:
    write("s6_abort.json", {"reason": "design not 200", "status": st,
                            "body": resp.decode(errors="replace")[:400]})
    raise SystemExit(1)

# 2. fill cuda:1 to leave ~400 MB free (< 409 ASR need => denial forced)
fill = subprocess.Popen([VENV_PY, OUT + r"\a24_filler.py", "15700"],
                        stdout=open(OUT + r"\filler_s6.log", "w"), stderr=subprocess.STDOUT)
deadline = t_design + 55
while time.time() < deadline and used_mb(1) < 15500:
    time.sleep(2)
write("s6_2_saturation.json", {"cuda0_used_mb": used_mb(0), "cuda1_used_mb": used_mb(1),
                               "fill_child_alive": fill.poll() is None,
                               "t_after_design_s": round(time.time() - t_design, 1)})

# 3. deny /transcribe (ASR pinned cuda:1, cold — never loaded on this instance)
pcm = struct.pack("<16000h", *([0] * 16000))
t1 = time.time()
st, resp = http("POST", "/transcribe", pcm,
                {"Content-Type": "application/octet-stream", "X-Sample-Rate": "16000"})
write("s6_3_transcribe.json", {"status": st, "body": resp.decode(errors="replace"),
                               "elapsed_s": round(time.time() - t1, 1),
                               "t_after_design_s": round(time.time() - t_design, 1)})

# 4. health at denial — cross-device pairing artifact
st, resp = http("GET", "/health", timeout=15)
h = json.loads(resp)
write("s6_4_health_at_denial.json", {"qwen_design_resident": h["qwen_design_resident"],
                                     "qwen_device_key": h["qwen_device_key"],
                                     "asr_loaded": h["asr_loaded"],
                                     "t_after_design_s": round(time.time() - t_design, 1)})
fill.terminate()
