# A17 second-admission-race driver (#1919 byte-for-byte reproduction)
# Sequence: warm VoiceDesign -> /qwen/clone-voice (holds _synth_lock, ungated)
# -> while inflight>=1 and design resident, fire /load coqui -> its
# qwen.design eviction step blocks on _synth_lock -> /health polled at 250ms
# throughout must stay responsive; eviction must free design BEFORE XTTS
# loads (no OOM). Single-card pinned via CUDA_VISIBLE_DEVICES=0 on launch.
import base64
import http.client
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

HOST = "127.0.0.1"
PORT = 9101
BASE = f"http://{HOST}:{PORT}"
OUT = r"C:\Users\dudar\AppData\Local\Temp\open-engine-ringer\oe-heartbeat-cline-qwen-cloud-3301-20260920-130430\oe-heartbeat-cline-qwen-cloud"
CSV = OUT + r"\a17-health-polls.csv"
EVENTS = OUT + r"\a17-events.jsonl"
SUMMARY = OUT + r"\a17-summary.json"

CAL = ("The old lighthouse keeper wrote a letter he would never send, "
       "folding it twice before the storm came back.")
AUDITION = "This line auditions the distilled clone voice inside the race window."
DESIGN_ID = "qwen-a17race-sep20-a"
CLONE_ID = "qwen-a17race-sep20-b"

events = []
lock = threading.Lock()


def ev(name, **kw):
    rec = {"t": round(time.time(), 3), "iso": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "name": name}
    rec.update(kw)
    with lock:
        with open(EVENTS, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)


def http_bytes(url, method="GET", body=None, headers=None, timeout=10):
    req = urllib.request.Request(url, data=body, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def health(timeout=10):
    st, _, body = http_bytes(BASE + "/health", timeout=timeout)
    return json.loads(body)


# ---- health poller: one persistent connection, 250 ms cadence ----
poll_rows = []
stop_poller = threading.Event()


def poller():
    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    while not stop_poller.is_set():
        t0 = time.time()
        err = ""
        fields = {}
        try:
            conn.request("GET", "/health")
            r = conn.getresponse()
            b = r.read()
            j = json.loads(b)
            fields = {
                "design_res": j.get("qwen_design_resident"),
                "inflight": j.get("inflight_synth"),
                "coqui_loaded": j.get("model_loaded"),
                "qwen_loaded": j.get("qwen_loaded"),
                "vram_res": j.get("vram_reserved_mb"),
                "poisoned": j.get("poisoned"),
                "recycle": j.get("recycle_pending"),
                "gpu0_free": (j.get("gpus") or [{}])[0].get("free_mb"),
                "ngpus": len(j.get("gpus") or []),
            }
        except Exception as e:  # noqa: BLE001
            err = type(e).__name__ + ":" + str(e)[:80]
            try:
                conn.close()
            except Exception:
                pass
            conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
        t1 = time.time()
        with lock:
            poll_rows.append((t0, (t1 - t0) * 1000.0, fields, err))
        time.sleep(max(0.0, 0.25 - (t1 - t0)))


def main():
    open(CSV, "w").close()
    open(EVENTS, "w").close()
    h = health()
    ev("phase0_health", ok=h.get("ok"), ngpus=len(h.get("gpus") or []),
       design_res=h.get("qwen_design_resident"),
       inflight=h.get("inflight_synth"))
    if len(h.get("gpus") or []) != 1:
        ev("ABORT_not_pinned")
        finish(2)
        return

    # Warm VoiceDesign (calibrationText => preview audio == known transcript)
    ev("design_start")
    body = json.dumps({"voiceId": DESIGN_ID,
                       "instruct": "A warm, measured storyteller with a low calm register.",
                       "language": "English", "calibrationText": CAL}).encode()
    t0 = time.time()
    st, hd, pcm = http_bytes(BASE + "/qwen/design-voice", "POST", body,
                             {"Content-Type": "application/json"}, timeout=900)
    sr = int(hd.get("x-sample-rate", "0"))
    ev("design_done", status=st, dur_s=round(time.time() - t0, 2), sr=sr,
       pcm_bytes=len(pcm), ctype=hd.get("content-type"))
    if st != 200 or sr <= 0 or len(pcm) < 4000:
        ev("ABORT_design_failed", detail=pcm[:300].decode(errors="replace"))
        finish(1)
        return
    h = health()
    ev("design_residency_check", design_res=h.get("qwen_design_resident"),
       qwen_loaded=h.get("qwen_loaded"))
    if not h.get("qwen_design_resident"):
        ev("ABORT_design_not_resident")
        finish(1)
        return

    threading.Thread(target=poller, daemon=True).start()
    time.sleep(1.0)

    clone_result = {}

    def do_clone():
        t = time.time()
        st2, hd2, b2 = http_bytes(
            BASE + "/qwen/clone-voice", "POST", pcm,
            {"Content-Type": "application/octet-stream",
             "X-Sample-Rate": str(sr), "X-Voice-Id": CLONE_ID,
             "X-Ref-Text": base64.b64encode(CAL.encode()).decode(),
             "X-Audition-Text": base64.b64encode(AUDITION.encode()).decode(),
             "X-Language": "English"}, timeout=600)
        clone_result.update(status=st2, dur_s=round(time.time() - t, 2),
                            body=b2[:200].decode(errors="replace"),
                            ctype=hd2.get("content-type"))
        ev("clone_done", **clone_result)

    th = threading.Thread(target=do_clone)
    th.start()
    ev("clone_fired")
    seen = None
    tb = time.time()
    while time.time() - tb < 20:
        hh = health(timeout=5)
        if (hh.get("inflight_synth") or 0) >= 1 and hh.get("qwen_design_resident"):
            seen = hh
            break
        time.sleep(0.01)
    if seen is None:
        ev("WARN_no_inflight_snapshot_before_load")
    else:
        ev("race_state_confirmed", design_res=seen.get("qwen_design_resident"),
           inflight=seen.get("inflight_synth"),
           vram_res=seen.get("vram_reserved_mb"),
           gpu0_free=(seen.get("gpus") or [{}])[0].get("free_mb"))

    # THE second admission, fired while design resident + forward live
    st, hd, b = http_bytes(BASE + "/load", "POST",
                           json.dumps({"engine": "coqui"}).encode(),
                           {"Content-Type": "application/json"}, timeout=600)
    load_body = b.decode(errors="replace")[:300]
    ev("load_done", status=st, body=load_body)
    th.join()
    time.sleep(1.0)
    stop_poller.set()
    time.sleep(0.3)

    lats = [r[1] for r in poll_rows]
    starts = [r[0] for r in poll_rows]
    gaps = [round((starts[i + 1] - starts[i]) * 1000.0, 2)
            for i in range(len(starts) - 1)]
    errs = [r for r in poll_rows if r[3]]
    with open(CSV, "w", encoding="utf-8") as fh:
        fh.write("t_start,lat_ms,t_end,design_res,inflight,coqui_loaded,"
                 "qwen_loaded,vram_res,poisoned,recycle,gpu0_free,ngpus,err\n")
        for t0p, lat, f, e in poll_rows:
            fh.write(f"{t0p:.3f},{lat:.2f},{t0p + lat / 1000.0:.3f},"
                     f"{f.get('design_res')},{f.get('inflight')},"
                     f"{f.get('coqui_loaded')},{f.get('qwen_loaded')},"
                     f"{f.get('vram_res')},{f.get('poisoned')},"
                     f"{f.get('recycle')},{f.get('gpu0_free')},"
                     f"{f.get('ngpus')},\"{e}\"\n")
    summary = {
        "polls": len(poll_rows), "poll_errors": len(errs),
        "max_single_latency_ms": round(max(lats), 2) if lats else None,
        "p50_latency_ms": round(sorted(lats)[len(lats) // 2], 2) if lats else None,
        "max_inter_start_gap_ms": max(gaps) if gaps else None,
        "clone": clone_result, "load_status": st, "load_body": load_body,
    }
    with open(SUMMARY, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2)
    ev("metrics", **summary)

    for eng in ("coqui", "qwen"):
        st3, _, b3 = http_bytes(BASE + "/unload", "POST",
                                json.dumps({"engine": eng}).encode(),
                                {"Content-Type": "application/json"}, timeout=120)
        ev("unload", engine=eng, status=st3,
           body=b3.decode(errors="replace")[:120])
    time.sleep(2)
    h = health()
    ev("final_health", design_res=h.get("qwen_design_resident"),
       coqui_loaded=h.get("model_loaded"), vram_res=h.get("vram_reserved_mb"),
       poisoned=h.get("poisoned"), inflight=h.get("inflight_synth"))
    finish(0)


def finish(code):
    try:
        stop_poller.set()
    except Exception:
        pass
    sys.stdout.flush()
    sys.exit(code)


if __name__ == "__main__":
    main()

