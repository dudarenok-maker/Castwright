"""A24 (#3299) live cross-device contention — orchestrator (round X).
Sequence inside the 120 s design TTL:
  1. /qwen/design-voice (fresh ASR-cold instance) -> design resident cuda:0
  2. filler saturates cuda:1 to ~400 MB free (< 409 MB ASR need)
  3. server/a24_node_retry.ts: REAL withCapacityRetry wrapping REAL POST
     /transcribe -> genuine noCapacity 503 deviceKey cuda:1 while
     qwen_design_resident=true/cuda:0 -> must fail at generic ~60 s budget
  4. health + result summary. Calibrated from a24_run6.py (15700 target).
"""
import json
import os
import subprocess
import time
import urllib.request

OUT = r"C:\Claude\Projects\wt-onbox-batch-1\docs\testing\onbox-mechanical-batch1-results\a24-capacity-device-scope-2026-09-21"
SERVER = r"C:\Claude\Projects\wt-onbox-batch-1\server"
BASE = "http://127.0.0.1:9020"
VENV_PY = SERVER + r"\tts-sidecar\.venv\Scripts\python.exe"
TSX = SERVER + r"\node_modules\.bin\tsx.cmd"


def write(name, obj):
    with open(OUT + "\\" + name, "w") as f:
        json.dump(obj, f, indent=2)


def http(method, path, data=None, headers=None, timeout=300):
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(3000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(3000)


def used_mb(idx):
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.used",
                          "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    for line in out.strip().splitlines():
        i, m = line.split(",")
        if int(i.strip()) == idx:
            return int(m.strip())
    return -1


def free_mb(idx):
    out = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.free",
                          "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    for line in out.strip().splitlines():
        i, m = line.split(",")
        if int(i.strip()) == idx:
            return int(m.strip())
    return -1


# 0. wait for a clean instance: ASR cold, design gone, cuda:1 empty again
t_clean = time.time()
while time.time() - t_clean < 200:
    st, resp = http("GET", "/health", timeout=15)
    h = json.loads(resp)
    if (not h["asr_loaded"]) and (not h["qwen_design_resident"]) and free_mb(1) > 15000:
        break
    time.sleep(5)
else:
    write("x_abort.json", {"reason": "instance never went clean",
                           "asr": h["asr_loaded"], "design": h["qwen_design_resident"],
                           "free1": free_mb(1)})
    raise SystemExit(1)
write("x0_clean.json", {"asr_loaded": h["asr_loaded"],
                        "design_resident": h["qwen_design_resident"],
                        "free1_mb": free_mb(1), "waited_s": round(time.time() - t_clean, 1)})

# 1. design with self-warm; a resident BASE is FINE (design-voice evicts it on
#    cuda:0 itself — proven 11:34 run, load_ms=17301). Only wait out a resident
#    DESIGN (would mean a stale cuda:0 squeeze from a previous round).
t_start = time.time()
t_design = None
while time.time() - t_start < 420:
    st, resp = http("GET", "/health", timeout=15)
    qwen = json.loads(resp)
    if qwen.get("qwen_design_resident"):
        time.sleep(5)
        continue
    payload = json.dumps({"voiceId": "a24x-2026-09-21",
                          "instruct": "a steady, friendly tutorial narrator"}).encode()
    st, resp = http("POST", "/qwen/design-voice", payload,
                    {"Content-Type": "application/json"}, timeout=300)
    if st == 200:
        t_design = time.time()
        write("x1_design.json", {"status": st,
                                 "elapsed_s": round(t_design - t_start, 1),
                                 "epoch_ms_done": int(t_design * 1000),
                                 "body_head": resp.decode(errors="replace")[:200]})
        break
    if st != 503:
        write("x_abort.json", {"reason": "design not 200/503", "status": st,
                               "body": resp.decode(errors="replace")[:400]})
        raise SystemExit(1)
    write("x1_design_503.json", {"status": st, "at_s": round(time.time() - t_start, 1),
                                 "body": resp.decode(errors="replace")[:200]})
    time.sleep(5)
if t_design is None:
    write("x_abort.json", {"reason": "design never got 200 (cuda:0 never cleared)"})
    raise SystemExit(1)

# 2. saturate cuda:1: nvidia-free < 900 MB (== torch-free < ~350 after the
#    sidecar's ~566 MB own context on cuda:1; fresh-admission ASR needs 409 MB
#    measured against torch-free)
fill = subprocess.Popen([VENV_PY, OUT + r"\a24_filler.py", "220", "8"],
                        stdout=open(OUT + r"\filler_x.log", "w"), stderr=subprocess.STDOUT)
deadline = t_design + 35
while time.time() < deadline and free_mb(1) > 900:
    time.sleep(2)
sat = {"cuda0_used_mb": used_mb(0), "cuda1_free_mb": free_mb(1),
       "fill_child_alive": fill.poll() is None,
       "t_after_design_s": round(time.time() - t_design, 1)}
write("x2_saturation.json", sat)
if sat["cuda1_free_mb"] >= 900:
    write("x_abort.json", {"reason": "cuda:1 never squeezed below 400 MB", "sat": sat})
    fill.terminate()
    raise SystemExit(1)

# 3. REAL withCapacityRetry against the REAL denial
env = os.environ.copy()
env["A24_T_DESIGN_DONE"] = str(int(t_design * 1000))
try:
    node = subprocess.run([TSX, "a24_node_retry.ts"],
                          cwd=SERVER, capture_output=True, text=True,
                          timeout=200, env=env)
    with open(OUT + r"\x3_node_stdout.txt", "w") as f:
        f.write(node.stdout or "")
    with open(OUT + r"\x3_node_stderr.txt", "w") as f:
        f.write(node.stderr or "")
    node_rc = node.returncode
except subprocess.TimeoutExpired as e:
    with open(OUT + r"\x3_node_stdout.txt", "w") as f:
        f.write((e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or ""))
    node_rc = "timeout-200s"

# 4. health right after + summary
st, resp = http("GET", "/health", timeout=15)
h = json.loads(resp)
write("x4_health_after_retry.json", {
    "qwen_design_resident": h["qwen_design_resident"],
    "qwen_device_key": h["qwen_device_key"],
    "asr_loaded": h["asr_loaded"],
    "t_after_design_s": round(time.time() - t_design, 1),
    "cuda1_used_mb": used_mb(1),
})
fill.terminate()
try:
    with open(OUT + r"\x3_node_retry.json") as f:
        x3 = json.load(f)
except Exception as e:
    x3 = {"error": str(e), "node_rc": node_rc}
write("x_result.json", {"saturation": sat, "node_retry": x3, "node_rc": node_rc})
