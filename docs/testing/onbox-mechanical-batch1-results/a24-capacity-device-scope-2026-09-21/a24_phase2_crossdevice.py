"""A24 bullet-5 live probe, phase 2: with the VoiceDesign resident on cuda:0,
saturate cuda:1 externally (ASR is pinned there via ASR_DEVICE=cuda:1), fire a
real /transcribe and capture the sidecar's actual noCapacity 503 body. The
artifact pair (deviceKey='cuda:1' vs health qwen_device_key='cuda:0') is the
live cross-device condition capacity-retry.ts:211 refuses to extend on."""
import json
import subprocess
import time
import urllib.request
import wave

OUT = r"C:\Claude\Projects\wt-onbox-batch-1\docs\testing\onbox-mechanical-batch1-results\a24-capacity-device-scope-2026-09-21"
BASE = "http://127.0.0.1:9020"

# 1. tiny 16-bit PCM wav for the transcribe call (0.5 s of silence, 16 kHz)
wav_path = OUT + r"\silence_05s.wav"
with wave.open(wav_path, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"\x00\x00" * 8000)

# 2. saturate cuda:1 from a detached child so the allocation survives this
#    script finishing the HTTP exchange below
sat = subprocess.Popen(
    [r"C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar\.venv\Scripts\python.exe", "-c",
     "import torch,time;free,tot=torch.cuda.mem_get_info(1);"
     "t=torch.empty(free-100*1024*1024,dtype=torch.uint8,device='cuda:1');"
     "torch.cuda.synchronize();time.sleep(90)"],
    cwd=r"C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar",
    stdout=open(OUT + r"\saturator.log", "w"), stderr=subprocess.STDOUT,
)
# use the venv python for the child
time.sleep(25)  # give torch context + big alloc time to land

def snap(tag):
    out = {}
    try:
        free, tot = __import__("subprocess").run(
            ["nvidia-smi", "--query-gpu=index,memory.free", "--format=csv,noheader"],
            capture_output=True, text=True).stdout.split("\n")
        out["nvidia_free"] = [free.strip(), tot.strip()]
    except Exception as e:
        out["nvidia_free_err"] = repr(e)
    return out

pre = snap("pre")
with open(OUT + r"\phase2_gpu_before_503.json", "w") as f:
    json.dump({"saturation_child_alive": sat.poll() is None, **pre}, f)

# 3. multipart POST /transcribe
import uuid
boundary = "----a24" + uuid.uuid4().hex
with open(wav_path, "rb") as f:
    audio = f.read()
mp = (
    f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"s.wav\"\r\n"
    "Content-Type: audio/wav\r\n\r\n").encode() + audio + f"\r\n--{boundary}--\r\n".encode()
req = urllib.request.Request(BASE + "/transcribe", data=mp,
                             headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                             method="POST")
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        res = {"http_status": r.status, "unexpected_body": r.read(400).decode(errors="replace")}
except urllib.error.HTTPError as e:
    res = {"http_status": e.code, "body": e.read().decode(errors="replace")[:2000]}
except Exception as e:
    res = {"error": repr(e)}
res["elapsed_s"] = round(time.time() - t0, 1)
with open(OUT + r"\phase2_transcribe_503.json", "w") as f:
    json.dump(res, f, indent=2)

# 4. live health snapshot alongside the denial
with urllib.request.urlopen(BASE + "/health", timeout=30) as r:
    h = json.load(r)
keep = {k: h.get(k) for k in ("qwen_design_resident", "qwen_device_key")}
with open(OUT + r"\health_at_denial.json", "w") as f:
    json.dump(keep, f, indent=2)

sat.terminate()
