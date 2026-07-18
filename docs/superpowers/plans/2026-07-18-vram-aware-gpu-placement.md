# Capacity-Aware Model Placement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠ ROUND-3 HARDENING (kickoff gate DONE) — these override the task bodies below
> where they differ, and supersede round-2 items #5 and #8.** The third gate
> verified the sidecar locking against `main.py` and reshaped the concurrency model;
> the corrected mechanics live in the spec (§Locking & concurrency, §Evict & wake,
> Resolved decisions). Where a task body still says `_synth_lock`-wrapped admission
> or an `_admission_lock`, these win:
>
> **Still binding from round 2:**
> 1. **Seed is the DECODE PEAK, not 4 GB.** `qwen` (0.6B @ default 32/3600) seed =
>    **6144**; the **primary acceptance test drives the real `FootprintTable`**,
>    never an injected `peak=5600`.
> 2. **Thread `batchWidth`+`tokenBudget`** from Node into BOTH `/synthesize` and
>    `/synthesize-batch` so a wide Qwen batch reserves its true peak.
> 3. **Node computes the evict decision.** 503 body `{noCapacity:true, neededMb,
>    deviceKey}`; Node reads Ollama `/api/ps` + `/capacity` and computes
>    `evictWouldHelp = analyzerMbOnDevice + freeOnDevice ≥ neededMb`.
> 4. **Node wake loop:** a queued TTS op retries on a bounded `/capacity` poll
>    (≈2 s, capped) + on each synth completion.
> 6. **`ReservationLedger` needs its own lock.**
> 7. **503 interception** before `throwForResponse`; disambiguate from poison
>    (`{poisoned:true}`) / recycle 503s.
> 9. **`poolWidth` for GPU engines stays the constant 1.**
> 10. **`psutil` is already module-level** (guarded) — guard CPU/mps rows.
>
> **Round-3 corrections (SUPERSEDE the task text):**
> 5′. **NO `_admission_lock`.** Admission (`PlacementController.admit` /
>    `reservation()`) is a **short critical section under the `ReservationLedger`'s
>    own lock** — decide + `hold` the peak, then RELEASE the lock before the forward.
>    Admission NEVER holds `_synth_lock` (non-reentrant `threading.Lock` at
>    `main.py:2071`; unload/evict paths re-acquire it → self-deadlock) and NEVER the
>    `asyncio` `_load_lock` (a `to_thread` worker can't acquire it — `main.py:2074`).
>    Same-engine thread-safety stays as-is: Qwen forward keeps `_synth_lock`;
>    Coqui/Kokoro forwards stay **parallel** (the `test_concurrent_synthesis`
>    contract — do NOT serialize them). Concurrent same-engine double-book is
>    prevented by the **ledger reservation** (each admit sees the other's peak in
>    `Σ reserved`), not a mutex.
> 8′. **Eviction barrier uses the THREADING load locks** `_base_load_lock`
>    (`main.py:2328`) / `_base17_load_lock` (`2346`), NOT the `asyncio` `_load_lock`.
> 11. **Published global lock order** (admit never up-orders): `ReservationLedger`
>    lock → threading load lock → `_synth_lock`/`_infer_lock`.
> 12. **Analyzer ↔ heavy TTS take turns per device (the OOM-window fix).** Node
>    does not start a new Ollama load on a device while a heavy TTS forward is
>    ramping there, and holds heavy TTS off a loading/resident analyzer — the two
>    big consumers never ramp concurrently on one 8 GB card. Per-call granularity;
>    a render does NOT preempt an in-flight analysis (it queues behind it).
> 13. **Wake-loop terminal state:** at the poll cap, when nothing will free VRAM,
>    **fail the op with an actionable toast** (not a permanent "Queued" pill). The
>    frontend e2e asserts the terminal toast.

**Goal:** Replace Castwright's hand-set GPU token budget with live per-device capacity measurement plus a per-call peak reservation, so model placement/eviction is driven by real free VRAM (and RAM), never a config guess — no OOM on a 1-card (8 GB) or 2-card (8 + 16 GB eGPU) box, no config change between them.

**Architecture (Option A — sidecar-owned TTS admission):** The Python sidecar is the placement authority for its own resident models (`GET /capacity`, a Python `FootprintTable` + `ReservationLedger`, a `PlacementController` that reserves each op's decode peak for the op's duration and returns a structured `503` when a device can't fit). Node owns the analyzer (a `CountSemaphore` width-K limiter + the Ollama `/api/ps` read + the evict decision), orchestrates the TTS retry/queue loop off the sidecar's `503`, and deletes the old budget knobs + weighted semaphore. Chosen after an adversarial review showed a Node-only reservation ledger can't safely gate sidecar-resident models it never observes.

**Tech Stack:** Python sidecar (FastAPI, pytest, torch); TypeScript server (Node 20, Vitest); React/RTK frontend (Vitest + Playwright).

**Design of record:** `docs/superpowers/specs/2026-07-18-vram-aware-gpu-placement-design.md`.

## Global Constraints

- **Own worktree + `feat/server-…` branch off `main`.** No work on `main`.
- **No OOM is the bar.** Every admission respects `Σ held peak reservations per device ≤ total − GPU_RESERVE_MB`. A test that admits past this is a plan failure.
- **Footprint = peak-under-load, never weight size** (Qwen 0.6B weights ~1.2 GB, decode-peak ~5.6 GB @ 32/3600).
- **`local-llm.md` is the maintained seed source of truth.** The sidecar seed map is a **parity-tested mirror** that parses the doc's numbers — not a keyword match.
- **On-box history is up-only:** `estimate = max(seed, observed)`.
- **TTS admission lives in the sidecar; the analyzer stays Node-gated.** A resident model is never migrated; device is chosen only on a cold load.
- **Admission is a short ledger-lock critical section, never a forward-spanning lock** (override 5′). Global lock order: ledger → threading load lock → `_synth_lock`/`_infer_lock`.
- **Analyzer and heavy TTS take turns per device** (override 12) — never ramp concurrently on one card; closes the Ollama admit→peak OOM window without inflating `GPU_RESERVE_MB`.
- **Every registry change runs `npm run config:sync` in the same commit.**
- **Commit convention** `<type>(<scope>): <subject>`, scopes `sidecar`/`server`/`frontend`. Frequent commits, one deliverable per task.

---

## File Structure

**Sidecar (Python):**
- `server/tts-sidecar/main.py` — `GET /capacity`, `probe_capacity()`; `FootprintTable`, `ReservationLedger`, `PlacementController`; wire admission into the real load/synth handlers (`_ensure_*_loaded`, ORT session pin, Coqui `.to`) as a **short `ReservationLedger`-lock critical section** (override 5′) — the forward then runs under the existing engine locks (Qwen `_synth_lock`; Coqui/Kokoro parallel).
- `server/tts-sidecar/tests/test_capacity.py`, `test_footprints.py`, `test_placement.py` (new); extend `test_devices.py`.

**Server (Node):**
- `server/src/gpu/count-semaphore.ts` (new) — the count core extracted from `GpuSemaphore`.
- `server/src/gpu/capacity-probe.ts` (new) — sidecar `/capacity` client + `nvidia-smi`/`rocm-smi` fallback.
- `server/src/analyzer/analyzer-concurrency.ts` — K limiter + lease onto `CountSemaphore`; drop the weighted GPU slot.
- `server/src/tts/sidecar.ts` — 503 orchestration; remove the per-engine `GpuSemaphore(1)`.
- `server/src/tts/synthesise-chapter.ts` — replace the budget barrier + `maxConcurrency` pool-width.
- `server/src/tts/persona-gpu-plan.ts`, `server/src/tts/embed-client.ts`, `server/src/analyzer/ollama.ts` — reconcile the other direct consumers.
- `server/src/gpu/residency.ts` — evict trigger from the sidecar 503.
- `server/src/routes/gpu-queue.ts` + `server/src/routes/diagnostics.ts` (+ tests) — payload migration.
- `server/src/config/registry.ts` (+ `config:sync`), `server/.env.example`.
- **Delete:** `server/src/gpu/semaphore.ts`, `server/src/tts/engine-vram-cost.ts`, `server/src/gpu/gpu-semaphore-gate.ts`, `server/src/gpu/device-total.ts`, `scripts/check-no-budget-poll.mjs` (+ tests).

**Frontend:** `src/store/*` + `src/components/layout.tsx` (per-device capacity in the pill; eGPU-drop toast + requeue); `e2e/gpu-queue-state.spec.ts` (new).

**Docs:** `docs/features/<n>-vram-aware-gpu-placement.md`, `docs/features/INDEX.md`, `docs/local-llm.md` (parity anchor), `docs/release-notes-next.md`, `RELEASE_NOTES.md`.

---

## Phase 1 — Sidecar: the admission authority

### Task 1: `GET /capacity` + cross-vendor probe

**Files:** Modify `server/tts-sidecar/main.py`; Test `server/tts-sidecar/tests/test_capacity.py` (new).

**Interfaces:** Produces `GET /capacity` → `{ "devices": [ { "kind": "cuda"|"rocm"|"mps"|"cpu", "index": int, "label": str, "totalMb": int, "freeMb": int } ] }`. Always ends with a `cpu` device. A per-device failure omits that device; never raises.

- [ ] **Step 1: Failing test**

```python
# server/tts-sidecar/tests/test_capacity.py
import server.tts_sidecar.main as main  # adjust to the repo import path used by other tests

def test_probe_always_includes_cpu(monkeypatch):
    monkeypatch.setattr(main, "_cuda_device_count", lambda: 0)
    monkeypatch.setattr(main, "_mps_available", lambda: False)
    d = main.probe_capacity()
    assert d[-1]["kind"] == "cpu" and d[-1]["freeMb"] > 0

def test_probe_enumerates_cuda(monkeypatch):
    monkeypatch.setattr(main, "_cuda_device_count", lambda: 2)
    monkeypatch.setattr(main, "_mps_available", lambda: False)
    monkeypatch.setattr(main, "_cuda_mem_get_info",
                        lambda i: (2*1024**3, 8*1024**3) if i == 0 else (15*1024**3, 16*1024**3))
    cuda = [x for x in main.probe_capacity() if x["kind"] == "cuda"]
    assert [c["totalMb"] for c in cuda] == [8192, 16384]
    assert cuda[0]["freeMb"] == 2048

def test_probe_omits_dead_device(monkeypatch):
    monkeypatch.setattr(main, "_cuda_device_count", lambda: 1)
    monkeypatch.setattr(main, "_mps_available", lambda: False)
    monkeypatch.setattr(main, "_cuda_mem_get_info", lambda i: (_ for _ in ()).throw(RuntimeError("GPU is lost")))
    d = main.probe_capacity()
    assert [x for x in d if x["kind"] == "cuda"] == [] and d[-1]["kind"] == "cpu"
```

- [ ] **Step 2: Run — FAIL.** `npm run test:sidecar -- -k test_capacity` → `AttributeError: probe_capacity`.

- [ ] **Step 3: Implement** — add module-level `import psutil` (today it's imported function-locally at `main.py:780`), the `_cuda_device_count/_cuda_mem_get_info/_cuda_is_rocm/_mps_available/_cuda_label` helpers (torch, each try/except), `probe_capacity()` (cuda/rocm loop with per-device try/except → omit on failure; mps if available with `psutil.virtual_memory().available`; always-append cpu), and `@app.get("/capacity")` returning `{"devices": probe_capacity()}`.

```python
def probe_capacity() -> list[dict]:
    devices = []
    kind = "rocm" if _cuda_is_rocm() else "cuda"
    for i in range(_cuda_device_count()):
        try:
            free_b, total_b = _cuda_mem_get_info(i)
            devices.append({"kind": kind, "index": i, "label": _cuda_label(i),
                            "totalMb": total_b // 1048576, "freeMb": free_b // 1048576})
        except Exception:
            continue
    if _mps_available():
        vm = psutil.virtual_memory()
        devices.append({"kind": "mps", "index": 0, "label": "apple-mps",
                        "totalMb": vm.total // 1048576, "freeMb": vm.available // 1048576})
    vm = psutil.virtual_memory()
    devices.append({"kind": "cpu", "index": 0, "label": "cpu",
                    "totalMb": vm.total // 1048576, "freeMb": vm.available // 1048576})
    return devices
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(sidecar): GET /capacity cross-vendor device probe"`

### Task 2: Python `FootprintTable` (parity mirror + up-only)

**Files:** Modify `main.py`; Test `server/tts-sidecar/tests/test_footprints.py` (new); Modify `docs/local-llm.md` (add a machine-parseable anchor row).

**Interfaces:** Produces `class FootprintTable: peak_mb(engine, model, cfg) -> int` (`max(seed, learned)`), `record(engine, model, cfg, observed_mb)` (up-only). `SEED_FOOTPRINTS_MB: dict[str,int]`.

- [ ] **Step 1: Failing tests**

```python
# server/tts-sidecar/tests/test_footprints.py
import re, pathlib
import server.tts_sidecar.main as main

def test_peak_is_above_weight_size():
    t = main.FootprintTable()
    assert t.peak_mb("qwen", "qwen-0.6b", {"batch": 32, "tokenBudget": 3600}) >= 5600  # real decode peak, not weight size

def test_ratchets_up_only():
    t = main.FootprintTable()
    base = t.peak_mb("coqui", None, {})
    t.record("coqui", None, {}, base + 400)
    assert t.peak_mb("coqui", None, {}) == base + 400
    t.record("coqui", None, {}, base - 400)
    assert t.peak_mb("coqui", None, {}) == base + 400

def test_seed_parity_with_local_llm_doc():
    # REAL parity: parse the numbers out of the maintained doc and compare.
    doc = pathlib.Path(__file__).parents[3].joinpath("docs/local-llm.md").read_text(encoding="utf8")
    # the doc carries a machine-parseable block, e.g. "<!-- footprint:qwen=6144 -->"
    parsed = {m[0]: int(m[1]) for m in re.findall(r"<!--\s*footprint:([\w.]+)=(\d+)\s*-->", doc)}
    assert parsed, "doc must carry footprint:<engine>=<mb> anchors"
    for k, v in parsed.items():
        assert main.SEED_FOOTPRINTS_MB[k] == v, f"{k}: seed {main.SEED_FOOTPRINTS_MB[k]} != doc {v}"
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — add `SEED_FOOTPRINTS_MB = {"kokoro":1200,"qwen":6144,"qwen.1.7b":7168,"coqui":3584,"asr":400,"spk":200}` (qwen = the measured ~5.6 GB decode peak rounded up, NOT the 4 GB resident/weight size); `FootprintTable` keying `f"{engine}.{model_tier}"` with the Qwen token-budget bump (`>=4800 → 7168`), an in-memory learned map, `peak_mb = max(seed, learned)`, `record = learned[k]=max(existing, observed)`. **Add matching `<!-- footprint:qwen=6144 -->` anchors to `docs/local-llm.md`** next to the sidecar table so the parity test has ground truth.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(sidecar): FootprintTable peak seeds mirror local-llm.md, up-only ratchet"`

### Task 3: `ReservationLedger` + `PlacementController` (the core)

**Files:** Modify `main.py`; Test `server/tts-sidecar/tests/test_placement.py` (new).

**Interfaces:** Produces
- `class ReservationLedger: reserved_mb(device_key)`, `hold(device_key, mb) -> token`, `release(token)`.
- `class PlacementController(probe=probe_capacity, footprints=FootprintTable(), ledger=ReservationLedger(), reserve_mb=lambda: int(os.environ.get("GPU_RESERVE_MB", 768)), idle_evict=..., is_resident=...)`.
  `admit(engine, model, cfg, cpu_capable, heavy) -> Admission` where `Admission` is `{"device": "cuda:1"}` | `{"device": "cpu"}` | `{"noCapacity": {"neededMb", "deviceKey"}}` (the sidecar does NOT set `analyzerEvictWouldHelp` — Node computes it from `/api/ps`, override 3), and a context-manager `reservation(engine, model, cfg, ...)` that holds the peak for the op and releases on exit. **`admit`/`reservation` take ONLY the `ReservationLedger`'s own lock, briefly, for the decide+`hold` (override 5′) — never `_synth_lock`, never the `asyncio` `_load_lock`.** `ReservationLedger` has its own `threading.Lock` guarding `reserved_mb`+`hold`+`release` (override 6).

- [ ] **Step 1: Failing tests (the OOM invariant)**

```python
# server/tts-sidecar/tests/test_placement.py
import server.tts_sidecar.main as main

def dev(kind="cuda", index=0, total=8192, free=8000):
    return {"kind": kind, "index": index, "label": "g", "totalMb": total, "freeMb": free}

def make(devices, peak, reserve=768, idle_evict=None, resident=None):
    fp = type("F", (), {"peak_mb": lambda *_: peak, "record": lambda *_: None})()
    return main.PlacementController(probe=lambda: devices, footprints=fp,
                                    ledger=main.ReservationLedger(), reserve_mb=lambda: reserve,
                                    idle_evict=idle_evict or (lambda dk: False),
                                    is_resident=resident or (lambda e: None))

def test_reserves_peak_so_second_op_cannot_double_book():
    devices = [dev(free=8000, total=8192)]
    pc = make(devices, peak=5600)
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as a1:
        assert a1["device"] == "cuda:0"
        # second op: 8192 - 5600(reserved) - 768 = -176 < 5600 -> no capacity
        a2 = pc.admit("qwen", "q", {}, cpu_capable=False, heavy=True)
        assert "noCapacity" in a2 and a2["noCapacity"]["neededMb"] == 5600
    # after the first releases, it fits again
    assert pc.admit("qwen", "q", {}, cpu_capable=False, heavy=True)["device"] == "cuda:0"

def test_prefers_roomier_device():
    devices = [dev(index=0, total=8192, free=3000), dev(index=1, total=16384, free=15000)]
    assert make(devices, 5600).admit("qwen", "q", {}, False, True)["device"] == "cuda:1"

def test_cheap_engine_falls_back_to_cpu():
    assert make([dev(free=200)], 1200).admit("kokoro", None, {}, cpu_capable=True, heavy=False)["device"] == "cpu"

def test_heavy_no_room_no_evict_reports_no_capacity_with_analyzer_hint():
    devices = [dev(free=1000)]
    a = make(devices, 5600).admit("qwen", "q", {}, cpu_capable=False, heavy=True)
    assert "noCapacity" in a and a["noCapacity"]["deviceKey"] == "cuda:0"

def test_idle_evict_then_place():
    devices = [dev(free=8000)]
    ledger = main.ReservationLedger(); tok = ledger.hold("cuda:0", 6000)
    fp = type("F", (), {"peak_mb": lambda *_: 5600, "record": lambda *_: None})()
    pc = main.PlacementController(probe=lambda: devices, footprints=fp, ledger=ledger,
                                  reserve_mb=lambda: 768,
                                  idle_evict=lambda dk: (ledger.release(tok) or True),
                                  is_resident=lambda e: None)
    assert pc.admit("qwen", "q", {}, False, True)["device"] == "cuda:0"
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — `ReservationLedger` (dict of device→{token: mb}, incrementing int token id, `reserved_mb` sums). `PlacementController.admit`: `peak = footprints.peak_mb(...)`; if `is_resident(engine)` returns a device, target it; else pick the max-headroom device where `min(freeMb, totalMb − ledger.reserved_mb(key)) − reserve_mb() >= peak`; on fit `ledger.hold` + return `{"device": key}`; else if `cpu_capable and not heavy` → `{"device":"cpu"}`; else try `idle_evict(worst_key)` once and re-run the fit; else return `{"noCapacity": {"neededMb": peak, "deviceKey": worst_short_device, "analyzerEvictWouldHelp": <shortfall covered by analyzer's share — computed by the caller from /api/ps, defaulted False here>}}`. `reservation(...)` is a `contextlib.contextmanager` that calls `admit` (ledger lock held only for the decide+`hold`, then released), yields it, and in `finally` releases the held token and `footprints.record(...)` the observed `torch.cuda.max_memory_allocated`. The `idle_evict` callback acquires the **threading** `_base_load_lock`/`_base17_load_lock` (override 8′), never the ledger lock or `_synth_lock`. **Wire it into the real handlers**: in `_ensure_base_loaded/_ensure_base17_loaded/_ensure_design_loaded` + the Coqui `.to` + the ORT session device pin, use the admitted device on a cold load; wrap each `/synthesize` body in `with pc.reservation(...)` **around** the existing forward — the reservation is held as VRAM bookkeeping while the forward runs under its normal locks (Qwen `_synth_lock`; Coqui/Kokoro parallel). Do NOT hold the ledger lock across the forward, and do NOT add any new lock around Coqui/Kokoro (override 5′ — preserve their tested parallelism). Global lock order (override 11): ledger → threading load lock → `_synth_lock`/`_infer_lock`.
- [ ] **Step 4: Run — PASS** (`npm run test:sidecar -- -k placement`).
- [ ] **Step 5: Commit** — `git commit -m "feat(sidecar): PlacementController peak-reservation admission + 503 no-capacity"`

### Task 4: Device honoring + 503 on the real endpoints

**Files:** Modify `main.py` (route glue); Test `server/tts-sidecar/tests/test_devices.py`.

- [ ] **Step 1: Failing test** — a `/synthesize` that can't fit returns HTTP `503` with `{noCapacity: true, neededMb, deviceKey}` (NO `analyzerEvictWouldHelp` — Node computes that, override 3); a cold `/load` places on the admitted device; a resident engine is not moved. Target the real FastAPI handlers via the test client used elsewhere in the suite.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — map `admit`'s `noCapacity` to a `JSONResponse(status_code=503, content={...})`; on `{"device": ...}` proceed as today. Preserve the `device` env fallback when the controller is disabled (feature flag `SEG_CAPACITY_ADMISSION`, default on) so a rollback path exists.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(sidecar): 503 no-capacity + device honoring on load/synthesize"`

---

## Phase 2 — Server plumbing

### Task 5: Extract `CountSemaphore`

**Files:** Create `server/src/gpu/count-semaphore.ts`; Test `server/src/gpu/count-semaphore.test.ts` (port the count-relevant `semaphore.test.ts` cases).

**Interfaces:** Produces `class CountSemaphore { constructor(max:number); acquire(opts?:{signal?}):Promise<()=>void>; resize(n:number):void; get queueDepth():number; get inFlight():number; get max():number; }` — the FIFO count core of today's `GpuSemaphore` with the token/cost weighting removed (every acquire is cost 1).

- [ ] **Step 1: Failing test** — FIFO order, `resize()` grows/drains, abort removes a queued waiter (mirror `semaphore.ts` behavior at count granularity).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — copy `GpuSemaphore`'s queue/drain/abort logic, drop `cost`/`clampCost`/`budget`/`usedTokens`/`maxConcurrency`; `max` getter replaces `budget`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): extract CountSemaphore from GpuSemaphore"`

### Task 6: Node `CapacityProbe` client + vendor fallback

**Files:** Create `server/src/gpu/capacity-probe.ts`; Test `server/src/gpu/capacity-probe.test.ts`.

**Interfaces:** As the spec: `read({fresh?}):Promise<ComputeDevice[]>` — sidecar `/capacity` first, `nvidia-smi`/`rocm-smi` fallback, CPU-only last; ~1500 ms last-known-good cache; never throws.

- [ ] **Step 1: Failing test** — sidecar-good path; sidecar-down → vendor fallback reports GPU; no-probe → CPU-only; cache TTL + `fresh`. (Same four tests as the prior draft — they were sound.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — `fetchSidecar` GETs `<sidecarUrl>/capacity` (URL resolved like `sidecar-health.ts`); `vendorProbe` shells `nvidia-smi --query-gpu=index,memory.total,memory.free --format=csv,noheader,nounits`, then `rocm-smi --showmeminfo vram --json`; CPU fallback via `os.freemem()/os.totalmem()`; cache `{at,devices}`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(server): CapacityProbe sidecar client with vendor fallback"`

---

## Phase 3 — Server cutover

### Task 7: Analyzer limiter + lease onto `CountSemaphore`

**Files:** Modify `server/src/analyzer/analyzer-concurrency.ts`; Test its existing spec.

- [ ] **Step 1: Failing test** — the width-K limiter still resizes live (`syncAnalyzerConcurrency`) and FIFO-drains; the per-model lease no longer acquires a weighted GPU slot (assert no `gpuSemaphore` import remains).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — swap `new GpuSemaphore(resolveK())` → `new CountSemaphore(resolveK())`; `resize` call unchanged. Delete the `enterModelLease` GPU-slot acquire (the VRAM gate is gone; K + `/api/ps` residency remain). Keep `getAnalyzerConcurrencyStats`/`describeAnalyzerConcurrency` but source the width from `CountSemaphore.max`.
- [ ] **Step 4: Run — PASS** (`cd server && npm run test -- analyzer-concurrency`).
- [ ] **Step 5: Commit** — `git commit -m "refactor(server): analyzer K limiter on CountSemaphore, drop weighted GPU lease"`

### Task 8: TTS call sites → 503 orchestration; remove per-engine lock

**Files:** Modify `server/src/tts/sidecar.ts`; Tests alongside.

**Interfaces:** Consumes the sidecar `503 {noCapacity: true, neededMb, deviceKey}` (Task 4 — Node computes `evictWouldHelp` itself from `/api/ps`, override 3), `CapacityProbe` (Task 6), `residency.ts` evict (Task 10).

- [ ] **Step 1: Failing test** — (a) a `200` synth returns audio unchanged; (b) a `503 noCapacity` where Node-computed `evictWouldHelp=true` with no analysis in flight triggers `evictOllama()` then one retry; (c) a `503` with analysis in flight enqueues (surfaces queue depth) and retries via the bounded poll/on-completion wake loop, never throws; (d) **at the poll cap with nothing to free, the op fails with an actionable toast** (`noCapacity` surfaced to the user), NOT an infinite wait (override 13).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — replace the per-engine `GpuSemaphore(1)` acquire (`sidecar.ts:40-49,121`) and the `acquireGpuTokenIfOnGpu` gate with: call `/synthesize`; parse the `noCapacity:true` body before `throwForResponse` (override 7); on it, branch evict-or-enqueue; a bounded wake loop (≈2 s poll, capped + wake on each synth completion) drives retries and a small FIFO waiter set (reuse `CountSemaphore` for the *queue-depth surface only*, or a minimal in-file queue) drives the pill; at the cap, reject with a user-facing no-capacity error (override 13). Same-engine serialization for Qwen lives in the sidecar `_synth_lock`; Coqui/Kokoro stay parallel — do **not** re-add a Node lock (override 5′).
- [ ] **Step 4: Run — PASS** (`cd server && npm run test -- sidecar`).
- [ ] **Step 5: Commit** — `git commit -m "refactor(server): TTS synth handles sidecar 503 with evict-or-queue"`

### Task 9: Reconcile the remaining budget consumers

**Files:** Modify `server/src/tts/synthesise-chapter.ts`, `server/src/tts/persona-gpu-plan.ts`, `server/src/tts/embed-client.ts`, `server/src/analyzer/ollama.ts`; Tests alongside each.

- [ ] **Step 1: Failing test** — (a) `synthesise-chapter` pool width no longer reads `gpuSemaphore.maxConcurrency` (source it from an account/config value or a constant — the GPU is now gated sidecar-side, so the chapter pool width is a throughput knob, not a VRAM gate); the full-budget barrier acquire at `:819` is removed; (b) `persona-gpu-plan` VoiceDesign barrier removed (sidecar admits VoiceDesign); (c) `embed-client` `budget >= 2` gate replaced with a capacity check or dropped; (d) `ollama.ts` module-load `describeAnalyzerConcurrency(costForEngine('analyzer'), gpuSemaphore.budget)` log rewritten to the K-only form.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** each per above; every changed file keeps a green test.
- [ ] **Step 4: Run — PASS** (`cd server && npm run typecheck && npm run test`).
- [ ] **Step 5: Commit** — `git commit -m "refactor(server): migrate synthesise-chapter/persona/embed/ollama off the GPU budget"`

---

## Phase 4 — Evict trigger, surfaces, deletion

### Task 10: Evict trigger + `/api/gpu/queue` + `diagnostics` + frontend

**Files:** Modify `server/src/gpu/residency.ts`, `server/src/routes/gpu-queue.ts` (+ test), `server/src/routes/diagnostics.ts` (+ test), `src/components/layout.tsx` (+ slice + test), `e2e/gpu-queue-state.spec.ts` (new).

- [ ] **Step 1: Failing tests** — (a) `residency.ts` evicts the analyzer only when Node-computed `evictWouldHelp` (from `/api/ps`+`/capacity`) and no analysis is mid-flight (replacing the `safeCoexistMb` threshold); (a′) **temporal separation (override 12):** Node holds a new Ollama load off a device while a heavy TTS forward is reserved there (and heavy TTS off a loading/resident analyzer) — assert the two never co-admit on one card; (b) `gpu-queue.ts` returns `{devices, residentByDevice, queueDepth}` and `diagnostics.ts` reads the migrated shape (update `diagnostics.test.ts:61`); (c) the pill renders per-device free + "Queued (N ahead)"; (d) e2e: a queued heavy op shows the pill and, when capacity never frees, **ends on the actionable no-capacity toast** (override 13) — never a spinner-forever; eGPU-drop dispatches a toast + re-queue.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** per above; keep `readGpuQueueState`'s name, change its return type and every caller in one commit.
- [ ] **Step 4: Run — PASS** (`cd server && npm run test -- "gpu-queue|diagnostics"`; `npm run test -- layout`; `npm run test:e2e -- gpu-queue-state`).
- [ ] **Step 5: Commit** — `git commit -m "feat(server): capacity-aware evict + per-device queue status + eGPU-drop toast"`

### Task 11: Delete the budget surface + registry migration

**Files:** Delete `server/src/gpu/semaphore.ts`, `server/src/tts/engine-vram-cost.ts`, `server/src/gpu/gpu-semaphore-gate.ts`, `server/src/gpu/device-total.ts`, `scripts/check-no-budget-poll.mjs` (+ their tests); Modify `server/src/config/registry.ts` (+ `config:sync`), `server/.env.example`.

- [ ] **Step 1: Failing test** — a registry test: the four budget knobs + six weights + `safeCoexistMb` are **absent**, `gpu.reserveMb` (default 768, `apply: live`, read by sidecar env too) is present. Before writing the "inert stale env" assertion, **grep how `ANALYZER` was actually retired** (memory: "`ANALYZER=gemini` is inert") and mirror that mechanism exactly — don't assume a `removed:` field exists if the real pattern is "unknown env vars are simply never read."
- [ ] **Step 2: Run — FAIL** (knobs present; deleted files still imported).
- [ ] **Step 3: Implement** — remove the knobs, add `gpu.reserveMb`, delete the five files + tests, fix every remaining import (Tasks 5–9 removed them; this catches stragglers), `npm run config:sync`, prune `.env.example`.
- [ ] **Step 4: Run — PASS** (`cd server && npm run typecheck && npm run test`; `npm run config:check`).
- [ ] **Step 5: Commit** — `git commit -m "refactor(server): delete GPU token budget knobs + weighted semaphore"`

### Task 12: Regression plan + release notes + verify + ship

**Files:** Create `docs/features/<n>-vram-aware-gpu-placement.md` (from `TEMPLATE.md`); update `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`; set the spec `status: active`.

- [ ] **Step 1:** Write the regression plan — invariants (per-call peak reservation held only as ledger bookkeeping, `min(...)` admit formula, up-only ratchet, sidecar-down fallback, eGPU-drop reconcile, analyzer-evict-only-when-it-helps, **analyzer↔heavy-TTS temporal separation per device**, **poll-cap fails with a toast not a hang**, and the **global lock order** ledger→threading-load-lock→`_synth_lock`) + the manual acceptance walkthrough on the 1-card and 2-card boxes (attach eGPU mid-run, drop it mid-run; run an analysis and a render together on the 8 GB card and confirm they take turns with no OOM and no permanent hang).
- [ ] **Step 2:** Append the technical + brand-voice release-notes lines.
- [ ] **Step 3:** `npm run verify:fast:branch`; then `npm run test:sidecar` (the new pytest tiers).
- [ ] **Step 4:** Push the branch, open the PR (`Closes #<issue>`), run the mandatory `code-review` gate (`high` — multi-scope refactor).
- [ ] **Step 5: Commit** — `git commit -m "docs(server): regression plan + release notes for capacity-aware placement"`

---

## Self-review notes

- **Spec coverage:** `/capacity` (T1), Python footprints + parity + up-only (T2), reservation ledger + placement controller + 503 (T3), device honoring on real endpoints (T4), CountSemaphore extraction (T5), Node capacity client + fallback (T6), analyzer limiter/lease cutover (T7), TTS 503 orchestration + per-engine-lock removal (T8), **all** other budget consumers (T9), evict + queue payload + diagnostics + frontend (T10), knob/file deletion + verified migration (T11), docs/release/verify/ship (T12).
- **Review fixes applied (rounds 1–2):** reservation lifetime now per-call in the sidecar where residency lives (crit-1/crit-2); `CountSemaphore` extracted not deleted (sig-1); every direct consumer has a task, no "fix imports" hand-wave (sig-2); sidecar tests target real handlers, parity test parses real numbers (sig-3, sig-5); `diagnostics.ts` migrated in T10 (sig-4); probe off the synth hot path, resident models never re-probe (min-1); registry migration verified against the real `ANALYZER` mechanism (min-2).
- **Round-3 (kickoff gate) fixes applied:** dropped `_admission_lock` — admission is a short ledger-lock critical section, forward under existing engine locks, double-book prevented by the ledger reservation not a mutex (5′); eviction barrier uses the threading `_base_load_lock`/`_base17_load_lock`, not the `asyncio` `_load_lock` a worker can't acquire (8′); published global lock order (11); analyzer↔heavy-TTS temporal separation closes the Ollama admit→peak OOM window (12); wake-loop fails with a toast at the cap (13); 503 body is `{noCapacity,neededMb,deviceKey}`, Node computes `evictWouldHelp`.
- **Ordering:** T8+T9+T11 must land in one PR (the shim removal + deletions are interdependent). T1–T4 (sidecar) can land as a first PR behind the `SEG_CAPACITY_ADMISSION` flag before the Node cutover.
- **Acceptance:** the "no OOM" invariant is T3 step 1 (peak reservation) exercised across all four hardware states.
