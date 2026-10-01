"""A24 bullet-5 live probe, phase 1: put a real 1.7B VoiceDesign resident on
cuda:0 (sidecar launched with QWEN_DEVICE=cuda:0) and capture /health proof
(qwen_design_resident=true, qwen_device_key='cuda:0')."""
import json
import time
import urllib.request

OUT = r"C:\Claude\Projects\wt-onbox-batch-1\docs\testing\onbox-mechanical-batch1-results\a24-capacity-device-scope-2026-09-21"
BASE = "http://127.0.0.1:9020"

body = json.dumps({
    "voiceId": "a24probe-2026-09-21",
    "instruct": "a calm, low, unhurried documentary narrator",
}).encode()
req = urllib.request.Request(BASE + "/qwen/design-voice", data=body,
                             headers={"Content-Type": "application/json"}, method="POST")
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=900) as r:
        audio = r.read()
        with open(OUT + r"\phase1_design_result.json", "w") as f:
            json.dump({"http_status": r.status, "audio_bytes": len(audio),
                       "sample_rate_header": r.headers.get("X-Sample-Rate"),
                       "elapsed_s": round(time.time() - t0, 1)}, f)
except urllib.error.HTTPError as e:
    with open(OUT + r"\phase1_design_result.json", "w") as f:
        json.dump({"http_status": e.code, "body": e.read().decode(errors="replace")[:2000],
                   "elapsed_s": round(time.time() - t0, 1)}, f)
except Exception as e:
    with open(OUT + r"\phase1_design_result.json", "w") as f:
        json.dump({"error": repr(e), "elapsed_s": round(time.time() - t0, 1)}, f)

with urllib.request.urlopen(BASE + "/health", timeout=30) as r:
    h = json.load(r)
keep = {k: h.get(k) for k in ("ok", "qwen_design_resident", "qwen_device_key",
                              "qwen_loaded", "qwen_design_ever_loaded", "gpus")}
with open(OUT + r"\health_after_design.json", "w") as f:
    json.dump(keep, f, indent=2)
