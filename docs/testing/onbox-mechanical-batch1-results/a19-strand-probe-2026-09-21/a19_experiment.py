"""A19 on-box acceptance probe (#3302) — can a stranded TTS VRAM pool survive
an explicit unload / `/recycle` MID-RENDER? Three prior in-app attempts (idle
TTL auto-unload, kill -9 mid-render, explicit /unload after a completed
render) all came back clean; #1993 (merged 873596d) already reclaims the
stranded pool on EVERY failing admission, so any survivor must route through
a NEW trigger. This harness supplies exactly the untried trigger shapes:

  EXP1  /recycle POSTed while a long batch render is in flight.
  EXP2C a FORCED LOAD FAILURE mid-load (foreign VRAM filler occupies the
        card while Coqui XTTS cold-loads) -> explicit /unload -> does the
        allocator pool survive with resident:[]?
  EXP2B a FORCED mid-render OOM (foreign filler grows while a 48-item
        /synthesize-batch forward runs) -> 500, process survives ->
        explicit /unload -> strand snapshot.
  EXP2A (runs only if C and B are clean) mid-batch bad-voice exception ->
        explicit /unload -> strand snapshot.
  EXP3  runs ONLY if a strand is observed: (a) denied op on a stranded
        card -> does #1993's guard already auto-reclaim it (reserved
        step-down in the health-poll trace without any manual /debug/reclaim)?
        (b) mid-render denied op -> guard-skip: NO step-down while a render
        holds the card. Strand snapshots are taken BEFORE any manual
        /debug/reclaim or denied op so nothing can mask a survivor.

Box: RTX 4060 Laptop 8188 MiB (CUDA_VISIBLE_DEVICES=0, the only compute
consumer), sidecar branch checkout at 9101, same isolation as the A17 clean
retry. Each phase runs in a FRESH sidecar process.

Outputs (this directory):
  a19-events.jsonl              phase events + verdicts
  a19-<phase>-health.jsonl      250 ms /health polls (per-device reserved)
  a19-<phase>-boot.log          uvicorn log (recycle/exit-43/reclaim lines)
  a19-<phase>-snapshot-*.json   full /health + /debug/memory + nvidia-smi
                                at the moment of the strand read
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR_DIR = r"C:\Claude\Projects\wt-onbox-batch-1\server\tts-sidecar"
VENV_PY = os.path.join(SIDECAR_DIR, ".venv", "Scripts", "python.exe")
BASE = "http://127.0.0.1:9101"
DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
T0 = time.time()

_events = open(os.path.join(HERE, "a19-events.jsonl"), "a", encoding="utf-8", buffering=1)


def ev(**kw):
    kw["t_rel"] = round(time.time() - T0, 2)
    kw["wall"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    _events.write(json.dumps(kw, default=str) + "\n")


def http(url, method="GET", body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + url, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def health(timeout=4):
    try:
        st, _, b = http("/health", timeout=timeout)
        return json.loads(b) if st == 200 else None
    except Exception:
        return None


def nvidia_smis():
    out = {}
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory",
             "--format=csv,noheader"], capture_output=True, text=True, timeout=20)
        out["compute_apps"] = r.stdout.strip()
        r2 = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,memory.used,memory.total",
             "--format=csv,noheader"], capture_output=True, text=True, timeout=20)
        out["gpu"] = r2.stdout.strip()
    except Exception as e:
        out["error"] = str(e)
    return out


CAL = "The old lighthouse keeper logged every ship that passed after dark, " \
      "and every storm that tried to stop him."
SENTENCES = [
    "The river carried the last light of the afternoon down past the mill.",
    "She opened the book carefully, as though its pages might still be warm.",
    "Every map in the archive disagreed about where the mountain stood.",
    "Rain tapped on the reading-room glass while the indexers went home.",
    "He counted the lanterns along the quay and found one burning late.",
    "The letter travelled three seasons before it reached the wrong address.",
    "Under the floorboards they found a century of small, patient secrets.",
    "Somewhere beyond the treeline the wind was practising its oldest song.",
]

SIDECAR_ENV_ADD = {
    "PORT": "9101",
    "LOCAL_TTS_HOST": "127.0.0.1",
    "IDLE_UNLOAD_SECONDS": "120",
    "CUDA_VISIBLE_DEVICES": "0",
    "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
}


class Phase:
    """Owns one fresh sidecar process + its 250 ms health poller."""

    def __init__(self, name):
        self.name = name
        self.samples = []
        self._stop = threading.Event()
        self.proc = None
        self.logf = None
        self.poller = None

    def launch(self):
        if health() is not None:
            raise RuntimeError("port 9101 already answering BEFORE launch - abort")
        self.logf = open(os.path.join(HERE, f"a19-{self.name}-boot.log"), "wb")
        env = dict(os.environ)
        env.update(SIDECAR_ENV_ADD)
        for k in ("PRELOAD_COQUI", "PRELOAD_KOKORO", "PRELOAD_QWEN"):
            env.pop(k, None)
        self.proc = subprocess.Popen(
            [VENV_PY, "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
             "--port", "9101"],
            cwd=SIDECAR_DIR, env=env, stdout=self.logf,
            stderr=subprocess.STDOUT, creationflags=DETACHED)
        deadline = time.time() + 240
        while time.time() < deadline:
            h = health()
            if h and h.get("ok") and (h.get("devices_state") or "") == "ready":
                break
            if self.proc.poll() is not None:
                raise RuntimeError(f"sidecar died at boot rc={self.proc.returncode}")
            time.sleep(2)
        else:
            raise RuntimeError("sidecar boot timeout")
        ev(phase=self.name, evt="booted", pid=self.proc.pid, nvidia=nvidia_smis())
        self.poller = threading.Thread(target=self._poll, daemon=True)
        self.poller.start()

    def _poll(self):
        hf = open(os.path.join(HERE, f"a19-{self.name}-health.jsonl"), "a",
                  encoding="utf-8", buffering=1)
        while not self._stop.is_set():
            h = health(timeout=2)
            if h is not None:
                rec = {
                    "t": round(time.time() - T0, 3),
                    "reserved_by_dev": h.get("vram_reserved_mb_by_device"),
                    "reserved": h.get("vram_reserved_mb"),
                    "inflight": h.get("inflight_synth"),
                    "recycle_pending": h.get("recycle_pending"),
                    "qwen_loaded": h.get("qwen_loaded"),
                    "resident": [g.get("resident") for g in (h.get("gpus") or [])],
                    "committed_mb": h.get("committed_mb"),
                }
                self.samples.append(rec)
                hf.write(json.dumps(rec) + "\n")
            else:
                self.samples.append({"t": round(time.time() - T0, 3), "health": None})
            time.sleep(0.25)
        hf.close()

    def wait_inflight(self, want=1, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            h = health()
            if h and (h.get("inflight_synth") or 0) >= want:
                return True
            time.sleep(0.2)
        return False

    def snapshot(self, tag):
        h = health(timeout=10)
        st, _, b = http("/debug/memory", timeout=30)
        try:
            dm = json.loads(b)
        except Exception:
            dm = {"_status": st, "_raw": b[:2000].decode(errors="replace")}
        snap = {"tag": tag, "health": h, "debug_memory": dm, "nvidia": nvidia_smis()}
        with open(os.path.join(HERE, f"a19-{self.name}-snapshot-{tag}.json"), "w",
                  encoding="utf-8") as f:
            json.dump(snap, f, indent=2, default=str)
        res = (h or {}).get("vram_reserved_mb_by_device") or {}
        ev(phase=self.name, evt="snapshot", tag=tag, reserved_by_dev=res)
        return snap

    def design(self, vid):
        body = {"voiceId": vid,
                "instruct": "A warm, measured storyteller with a low calm register.",
                "language": "English", "calibrationText": CAL}
        t = time.time()
        st, hd, b = http("/qwen/design-voice", "POST", body, timeout=900)
        ev(phase=self.name, evt="design", voice=vid, status=st,
           dur_s=round(time.time() - t, 2), pcm_bytes=len(b))
        return st, hd, b

    def batch(self, vid, n, bad_voice_at=None, timeout=1200):
        """POST /synthesize-batch (qwen 0.6b) in a thread -> (result, thread)."""
        res = {}

        def run():
            items = []
            for i in range(n):
                v = vid
                if bad_voice_at is not None and i == bad_voice_at:
                    v = "a19-ghost-voice-does-not-exist"
                s = " ".join(SENTENCES[(i + k) % len(SENTENCES)] for k in range(3))
                items.append({"voice": v, "text": s})
            t = time.time()
            try:
                st, _, b = http("/synthesize-batch", "POST",
                                {"engine": "qwen", "model": "0.6b",
                                 "items": items, "liveInstruct": False},
                                timeout=timeout)
                res.update(status=st, bytes=len(b),
                           dur_s=round(time.time() - t, 2),
                           body_head=b[:220].decode(errors="replace"))
            except Exception as e:
                res.update(status=None,
                           error=type(e).__name__ + ":" + str(e)[:200],
                           dur_s=round(time.time() - t, 2))
            ev(phase=self.name, evt="batch_result", **res)

        th = threading.Thread(target=run)
        th.start()
        return res, th

    def unload_all(self):
        for eng in ("qwen", "coqui", "kokoro"):
            http("/unload", "POST", {"engine": eng}, timeout=120)

    def kill(self, why="cleanup"):
        self._stop.set()
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            try:
                self.proc.wait(timeout=30)
            except Exception:
                pass
            ev(phase=self.name, evt="killed", why=why)
        elif self.proc is not None:
            ev(phase=self.name, evt="already_exited", rc=self.proc.returncode,
               why=why)
        if self.logf:
            try:
                self.logf.close()
            except Exception:
                pass


def spawn_filler(mb):
    f = open(os.path.join(HERE, f"a19-filler-{mb}.log"), "wb")
    p = subprocess.Popen(
        [VENV_PY, os.path.join(HERE, "fill_foreign.py"), str(mb)],
        stdout=f, stderr=subprocess.STDOUT, creationflags=DETACHED)
    ev(evt="filler_spawn", pid=p.pid, target_mb=mb)
    return p, f


def kill_filler(p, f):
    if p.poll() is None:
        p.kill()
        try:
            p.wait(timeout=30)
        except Exception:
            pass
    f.close()
    ev(evt="filler_killed", pid=p.pid)


def reserved_of(snap):
    """torch allocator reserved MB for the (single) card. Health reports
    `vram_reserved_mb_by_device` as {"cuda:N": {"reserved_mb": X, ...}}."""
    res = (snap.get("health") or {}).get("vram_reserved_mb_by_device") or {}
    vals = []
    for v in res.values():
        if isinstance(v, dict):
            x = v.get("reserved_mb")
            vals.append(x if isinstance(x, (int, float)) else None)
        elif isinstance(v, (int, float)):
            vals.append(v)
    vals = [v for v in vals if v is not None]
    return max(vals) if vals else None


STRAND_MB = 800  # reserved above this with NO resident engine after explicit
                 # unload = a pool that survived unload (strand). Boot-time
                 # context-init reserved stays well under this on this box.


def bootlog_tail(name, needles, tail=400):
    """Return boot-log lines containing any of `needles` (case-insensitive)."""
    path = os.path.join(HERE, f"a19-{name}-boot.log")
    try:
        with open(path, "rb") as f:
            lines = f.read().decode(errors="replace").splitlines()
    except Exception:
        return []
    hits = [l for l in lines[-4000:] if any(n.lower() in l.lower() for n in needles)]
    return hits[-tail:]


def exp1():
    """A19 bullet-1 trigger #4: POST /recycle mid-render."""
    p = Phase("exp1-recycle-midrender")
    try:
        p.launch()
        st, _, _ = p.design("a19-exp1-narrator")
        if st != 200:
            ev(phase=p.name, evt="ABORT", why="design failed", status=st)
            return
        res, th = p.batch("a19-exp1-narrator", 16)
        got = p.wait_inflight()
        ev(phase=p.name, evt="inflight_confirmed", ok=got)
        t = time.time()
        st2, _, b2 = http("/recycle", "POST", {}, timeout=30)
        ev(phase=p.name, evt="recycle_post", status=st2, body=b2[:200].decode(errors="replace"))
        th.join(timeout=600)
        ev(phase=p.name, evt="batch_after_recycle", **res,
           inflight_after_s=round(time.time() - t, 1))
        # exit(43) fires once _inflight_synth drains (or at the 180 s grace cap)
        deadline = time.time() + 300
        while time.time() < deadline and p.proc.poll() is None:
            time.sleep(1)
        rc = p.proc.returncode
        ev(phase=p.name, evt="process_exit", rc=rc)
        time.sleep(3)
        nv = nvidia_smis()
        ev(phase=p.name, evt="gpu_after_exit", nvidia=nv,
           verdict=("NO surviving pool: /recycle mid-render hard-exits the "
                    "process (rc 43 expected); the CUDA context that owns the "
                    "allocator dies with it, so nothing can outlive an unload "
                    f"that IS a process death. GPU compute apps: {nv.get('compute_apps')!r}"))
        ev(phase=p.name, evt="bootlog_recycle_lines",
           lines=bootlog_tail("exp1-recycle-midrender",
                              ["recycl", "drain", "exit", "43"]))
    finally:
        p.kill(why="exp1-end")


def exp2c():
    """Trigger #5: FORCED mid-load chapter failure (CUDA OOM while XTTS
    weights stream in), then explicit /unload, then the strand read."""
    p = Phase("exp2c-loadfail")
    stranded = False
    try:
        p.launch()
        fp, ff = spawn_filler(6500)
        filler_ready(6500)
        t = time.time()
        st, _, b = http("/load", "POST", {"engine": "coqui"}, timeout=600)
        ev(phase=p.name, evt="load_attempt", status=st, dur_s=round(time.time() - t, 2),
           body=b[:300].decode(errors="replace"))
        kill_filler(fp, ff)
        if st == 200:
            ev(phase=p.name, evt="note", why="load SUCCEEDED under filler "
               "(admitted anyway or filler slow) - unloading it as a plain "
               "load/unload cycle")
        p.unload_all()
        time.sleep(15)  # deferred-unload grace + allocator settle
        snap = p.snapshot("post-unload")
        res_mb = reserved_of(snap)
        stranded = res_mb is not None and res_mb >= STRAND_MB
        ev(phase=p.name, evt="strand_read", reserved_mb=res_mb,
           threshold_mb=STRAND_MB, stranded=stranded,
           verdict=("STRAND: allocator pool survived explicit /unload with no "
                    "engine resident" if stranded else
                    "CLEAN: explicit /unload after a forced mid-load failure "
                    "left no surviving pool (reserved ~= process context only)"))
        if stranded:
            p.reclaim_probe()
            p.snapshot("post-reclaim")
        ev(phase=p.name, evt="bootlog_failure_lines",
           lines=bootlog_tail("exp2c-loadfail", ["reclaim", "stranded", "out of memory", "OOM", "load fail"])[:80])
    finally:
        p.kill(why="exp2c-end")
    return stranded




def filler_ready(mb, timeout=150):
    path = os.path.join(HERE, f"a19-filler-{mb}.log")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if "READY" in open(path, "rb").read().decode(errors="replace"):
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def strand_read(p, tag="post-unload"):
    snap = p.snapshot(tag)
    res_mb = reserved_of(snap)
    stranded = res_mb is not None and res_mb >= STRAND_MB
    ev(phase=p.name, evt="strand_read", tag=tag, reserved_mb=res_mb,
       threshold_mb=STRAND_MB, stranded=stranded,
       verdict=("STRAND: pool survived explicit /unload with no engine resident"
                if stranded else
                "CLEAN: no surviving pool after explicit /unload"))
    if stranded:
        p.reclaim_probe()
        p.snapshot("post-manual-reclaim")
    return stranded


def exp2b():
    """Trigger #6: forced mid-render CUDA OOM (foreign filler grows during a
    batched forward) -> 500, process survives -> explicit /unload -> strand."""
    p = Phase("exp2b-renderoom")
    fp = ff = None
    stranded = False
    try:
        p.launch()
        st, _, _ = p.design("a19-exp2b-narrator")
        if st != 200:
            ev(phase=p.name, evt="ABORT", why="design failed", status=st)
            return False
        res, th = p.batch("a19-exp2b-narrator", 32)
        p.wait_inflight()
        fp, ff = spawn_filler(4500)
        filler_ready(4500)
        th.join(timeout=900)
        if res.get("status") == 200:
            ev(phase=p.name, evt="note",
               why="render finished before OOM bit - one retry, bigger filler")
            kill_filler(fp, ff); fp = ff = None
            res, th = p.batch("a19-exp2b-narrator", 32)
            p.wait_inflight()
            fp, ff = spawn_filler(5200)
            filler_ready(5200)
            th.join(timeout=900)
        kill_filler(fp, ff); fp = ff = None
        h = health()
        ev(phase=p.name, evt="post_failure_process", survived=h is not None,
           batch_status=res.get("status"), batch_error=res.get("error"))
        p.unload_all()
        time.sleep(15)
        stranded = strand_read(p)
        ev(phase=p.name, evt="bootlog_failure_lines",
           lines=bootlog_tail("exp2b-renderoom",
                              ["reclaim", "stranded", "out of memory", "OOM",
                               "batch synth failed"])[:80])
    finally:
        if fp and ff:
            kill_filler(fp, ff)
        p.kill(why="exp2b-end")
    return stranded


def exp2a():
    """Trigger #7 (fallback): mid-batch engine exception (unknown voice at
    item 8) -> explicit /unload -> strand."""
    p = Phase("exp2a-badvoice")
    stranded = False
    try:
        p.launch()
        st, _, _ = p.design("a19-exp2a-narrator")
        if st != 200:
            ev(phase=p.name, evt="ABORT", why="design failed", status=st)
            return False
        res, th = p.batch("a19-exp2a-narrator", 16, bad_voice_at=8)
        th.join(timeout=900)
        ev(phase=p.name, evt="badvoice_outcome", **res)
        p.unload_all()
        time.sleep(15)
        stranded = strand_read(p)
    finally:
        p.kill(why="exp2a-end")
    return stranded



def exp3():
    """Bullet 2+3 (only if a strand was reproduced): re-create the strand, then
    (a) denied op with nothing resident -> does #1993's guard already
    auto-reclaim it (reserved step-down with NO manual /debug/reclaim)?
    (b) denied op WHILE a render holds the card -> guard must SKIP (no
    step-down). (c) two denied ops <30 s apart -> at most one reclaim."""
    p = Phase("exp3-guard")
    fp = ff = None
    try:
        def denied_design(vid):
            return http("/qwen/design-voice", "POST",
                        {"voiceId": vid, "instruct": "A calm narrator.",
                         "language": "English", "calibrationText": CAL},
                        timeout=600)

        def restand(mb=6500):
            nonlocal fp, ff
            fp, ff = spawn_filler(mb)
            filler_ready(mb)
            st, _, b = http("/load", "POST", {"engine": "coqui"}, timeout=600)
            kill_filler(fp, ff); fp = ff = None
            ev(phase=p.name, evt="restand_load", status=st,
               body=b[:200].decode(errors="replace"))
            p.unload_all()
            time.sleep(15)
            return reserved_of(p.snapshot("restand"))

        r0 = restand()
        ev(phase=p.name, evt="exp3_prelude", reserved_mb=r0,
           note="strand re-created for guard tests" if (r0 or 0) >= STRAND_MB
           else "strand NOT reproducible in exp3 - guard tests moot")
        if (r0 or 0) < STRAND_MB:
            return
        # (a) denied op, nothing resident -> #1993 guard SHOULD auto-reclaim
        fp, ff = spawn_filler(6500)
        filler_ready(6500)
        t = time.time()
        st, _, b = denied_design("a19-exp3-denied")
        ev(phase=p.name, evt="denied_op_idle", status=st,
           dur_s=round(time.time() - t, 1), body=b[:260].decode(errors="replace"))
        kill_filler(fp, ff); fp = ff = None
        time.sleep(5)
        ra = reserved_of(p.snapshot("post-denied-idle"))
        ev(phase=p.name, evt="guard_autoreclaim_verdict", before=r0, after=ra,
           reclaimed_by_guard=(ra is not None and ra < r0 - 200),
           note=("reserved stepped DOWN across a denied op with NO manual "
                 "/debug/reclaim -> #1993 guard already live on this box"
                 if (ra is not None and ra < r0 - 200) else
                 "no step-down: denied op did NOT auto-reclaim the strand"))
        # (b) mid-render denied op -> guard must SKIP (reserved stays up)
        r1 = restand()
        p.design("a19-exp3-render")
        res, th = p.batch("a19-exp3-render", 32)
        p.wait_inflight()
        fp, ff = spawn_filler(6500)
        filler_ready(6500)
        st, _, b = http("/load", "POST", {"engine": "coqui"}, timeout=600)
        rb_mid = reserved_of(p.snapshot("denied-midrender"))
        ev(phase=p.name, evt="denied_op_midrender", status=st,
           body=b[:260].decode(errors="replace"), reserved_before=r1,
           reserved_midrender=rb_mid,
           guard_skipped=(rb_mid is not None and r1 is not None
                          and rb_mid > r1 - 200))
        kill_filler(fp, ff); fp = ff = None
        th.join(timeout=900)
        p.unload_all()
        time.sleep(10)
        # (c) cooldown: two denied ops ~3 s apart -> at most ONE reclaim step
        rc_ = reserved_of(p.snapshot("pre-cooldown"))
        fp, ff = spawn_filler(6500)
        filler_ready(6500)
        s1, _, _ = denied_design("a19-exp3-d1")
        time.sleep(3)
        s2, _, _ = denied_design("a19-exp3-d2")
        kill_filler(fp, ff); fp = ff = None
        time.sleep(5)
        rd = reserved_of(p.snapshot("post-cooldown-pair"))
        ev(phase=p.name, evt="cooldown_pair", first_status=s1, second_status=s2,
           reserved_pre=rc_, reserved_post=rd)
        time.sleep(31)
        fp, ff = spawn_filler(6500)
        filler_ready(6500)
        s3, _, _ = denied_design("a19-exp3-d3")
        kill_filler(fp, ff); fp = ff = None
        re_ = reserved_of(p.snapshot("post-cooldown-expired"))
        ev(phase=p.name, evt="cooldown_after_30s", third_status=s3,
           reserved_post_expiry=re_)
        ev(phase=p.name, evt="bootlog_reclaim_lines",
           lines=bootlog_tail("exp3-guard", ["reclaim", "stranded"])[:80])
    finally:
        if fp and ff:
            kill_filler(fp, ff)
        p.kill(why="exp3-end")


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    verdict = {"started": time.strftime("%Y-%m-%dT%H:%M:%S"), "box": nvidia_smis()}
    try:
        if which in ("all", "exp1"):
            exp1()
        if which in ("all", "exp2c"):
            verdict["strand_exp2c_loadfail"] = exp2c()
        if which in ("all", "exp2b"):
            verdict["strand_exp2b_renderoom"] = exp2b()
        if which == "all" and not (verdict.get("strand_exp2c_loadfail")
                                   or verdict.get("strand_exp2b_renderoom")):
            verdict["strand_exp2a_badvoice"] = exp2a()
        if which in ("all", "exp3") and any(
                v for k, v in verdict.items() if k.startswith("strand")):
            exp3()
            verdict["exp3_ran"] = True
    finally:
        verdict["finished"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(os.path.join(HERE, "a19-verdict.json"), "w", encoding="utf-8") as f:
            json.dump(verdict, f, indent=2, default=str)
        ev(evt="DONE", **{k: v for k, v in verdict.items() if k != "box"})
    print("A19-HARNESS-DONE")


if __name__ == "__main__":
    main()

