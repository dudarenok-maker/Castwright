# Multi-GPU Wave 2 + Plan 2 — Per-Card Safety & Picker UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Grounded against the CURRENT `main` tree (post Wave 1 / PR #1180, post the basic device-picker dropdown / PR #1205) via four parallel research passes over `server/tts-sidecar/main.py`, the Node `gpu/*`/`tts/*`/`config/*` layer, and the frontend Advanced Configuration surface. Every line number below was read from the live file at plan-authoring time — re-verify with a quick `grep -n` before editing if this plan is executed after further changes land.

**Goal:** Make the multi-GPU runtime actually SAFE for cross-card placement (Wave 2 — no UI, sidecar + server only), then extend the existing Advanced Configuration device rows (shipped in #1205) into the richer picker the design spec calls "Plan 2" — canonical GPU-UUID identity, stale-reason badges, an analyzer read-only row, and auto-revert on a repeated bad pin. Ships as **two sequenced PRs** (Wave 2 first — runtime only, mirrors how Wave 1 shipped; Plan 2 second, gated on Wave 2's on-box acceptance since Plan 2 §2.3 auto-revert directly consumes Wave 2 §W2.5's trip event).

**Architecture:** A `DeviceLedger` (Python, thread-safe, never caches an index) becomes the single source of per-card VRAM truth the recycle watchdog, the `_VdKokoroArbiter` coupling, and a new per-card load/evict mutex all read through. A code-43 self-exit now persists a small breadcrumb file so the Node-side `sidecar-supervisor.ts` — which outlives any single sidecar process — can count a structural-undersize streak across restarts and hold TTS down. Node gains two coarse (GPU/CPU-only, never per-card) guards over the existing single global `GpuSemaphore`. Plan 2 stores a device override as a canonical GPU UUID (survives index renumbering), reconciled against the live device list on every read, and layers badges/an auto-revert action/an analyzer row onto the EXISTING `OverrideRow`/`advanced.tsx` surface from #1205 rather than a new panel.

**Tech Stack:** Python 3.12 sidecar (Starlette/FastAPI, torch, threading), pytest. Node 20 server (TypeScript/ESM NodeNext, Express), Vitest. React 18 + Redux Toolkit frontend, Vitest + React Testing Library, Playwright e2e, axe-core a11y.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-27-multi-gpu-per-model-design.md` — "Plan 1 / Wave 2" (§W2.1–W2.6, lines 151-226) and "Plan 2" (§2.1–2.5, lines 230-278), plus the "Round 5 — Wave 2 + Plan 2 execution decisions" section appended 2026-07-02 that locks: 1024 MB driver-free-floor default (tune on-box, don't gate on it), whole-process code-43 recycle stays a documented v1 limit, Node GPU budgets stay coarse/global (no per-UUID pool), and Plan 2's picker builds on the EXISTING Advanced Configuration rows (NOT a new Model Manager panel — that framing from issue #1202 is superseded).
- **Already shipped, do not re-do:** Wave 1 (PR #1180) — device discovery (`_enumerate_cuda_devices`/`_sample_card`), the `device` knob type widened onto `tts.qwen.device`/`tts.coqui.device`/`tts.kokoro.device` (NOT `qa.speaker.device`/`qa.asr.device`, which stay plain `string`), `_parse_device`/`_ct2_kwargs`/`_spk_run_device`, `GET /api/gpu/devices`, `/health` `gpus[]` with `resident[]`/`stale_reason:'cpu_fallback'`. PR #1205 — the `OverrideRow` `type==='device'` `<select>` (auto/cpu/mps/cuda:N, stale value stays selectable), `AdvancedView`'s `gpuDevices` fetch-on-mount. **Kokoro `device_id` plumbing is ALSO already resolved** (Wave 1 Task 6's spike): `main.py` lines 1136-1146 show the pinned `kokoro-onnx` does NOT accept `provider_options=`, so the shipped code rebuilds `self._kokoro.sess` via `onnxruntime.InferenceSession(..., provider_options=opts)` after construction — no further spike needed anywhere in this plan.
- **Engine device dialects (unchanged from Wave 1):** torch `.to("cuda:N")` (Qwen/Coqui/SPK), CTranslate2 `device`+`device_index` (Whisper), ONNX-Runtime session rebuild (Kokoro). `_parse_device(value) -> (family, index)` is the one grammar helper everything routes through.
- **Threading model in `main.py`:** plain non-reentrant `threading.Lock` is the house style (`self._cache_lock`, `self._synth_lock` at 1603/1615, per-engine `_load_lock` — actually an `asyncio.Lock` per engine, held across `to_thread` offloads — see Task 5 note). `_VdKokoroArbiter` (585-634) is the one `threading.Condition`-based exception. A new `DeviceLedger` lock must never be held while calling back into a method that re-acquires it (see Task 1's `_sample_locked` factoring — avoids a deadlock a naive `sample_all()`-calls-`sample()` design would hit).
- **The self-exit path never carries card info today.** `_schedule_restart_exit(metric_mb, threshold_mb, metric_label)` (main.py:3768) and `_restart_now()` (3710) know nothing about WHICH card (if any) triggered a VRAM-ceiling breach. Tasks 2 and 6 add that, ending at a small breadcrumb file (`server/tts-sidecar/.run/last-restart-trip.json`) because `onChildExit(code, signal)` in `sidecar-supervisor.ts:258` — the only Node-side signal a child has exited — carries NEITHER; the dying process must persist the card to disk before it vanishes.
- **The Node GPU semaphore is ONE global pool, on purpose** (`gpu/semaphore.ts:35-134`, capacity fixed at construction, `acquire()` decides synchronously). Wave 2 does NOT rebuild it per-card (Non-goals, spec line 92-94; Round 5 confirms this stays deferred). The two W2.6 guards are coarse GPU/CPU-only signals layered on top.
- **Commit convention:** `<type>(<scope>): <subject>`, scopes `sidecar`/`server`/`frontend`, ≤100 chars; no `--no-verify`.
- **Testing discipline:** every behaviour change ships a paired test that fails-before/passes-after; **never `Write`-clobber an existing test file — append**, matching Wave 1's convention. Sidecar tests run via `.\.venv\Scripts\python.exe -m pytest` from `server/tts-sidecar` (bootstrap per `server/tts-sidecar/README.md` if the venv is missing — `npm run test:sidecar` SKIPs with a banner rather than failing on a fresh clone).
- **`verify` gates touched here:** `config:check` (env-example sync — `npm run config:sync` from repo root, needed whenever a registry knob is added) and `test:server`/`test`/`test:sidecar`.
- **On-box acceptance is owed, not optional.** Both Wave 2 and Plan 2 end in a Ship-notes checklist run on the real 2-GPU box (RTX 4070 Laptop 8GB + RTX 5070 Ti 16GB) — `test:sidecar` is venv-gated so CI never exercises the real CUDA paths.

---

# PART A — Wave 2: Per-Card Safety (sidecar + server, no UI change)

### Task 1: `DeviceLedger` — thread-safe per-card sampler (§W2.1)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `DeviceLedger` class near `_enumerate_cuda_devices`/`_sample_card`, currently at lines 3590-3614; add module singleton `_DEVICE_LEDGER`)
- Create: `server/tts-sidecar/tests/test_device_ledger.py`

**Interfaces (consumed by Tasks 2, 5, 6):**
- `DeviceLedger(torch_module: Any = None)` — `torch_module` injectable for tests, matching every other Wave-1 helper's convention (never `monkeypatch.setattr(main, "torch")`, since sidecar code imports torch function-locally).
- `ledger.sample(idx: int) -> Optional[dict]` — one card's current `{uuid,idx,name,total_mb,free_mb}` (Wave 1's `_sample_card` shape), or `None` if the card has vanished OR its uuid no longer matches what THIS ledger last saw at that index (a renumber — never silently substitutes a different physical card's reading).
- `ledger.sample_all() -> list[dict]` — every visible card, each independently re-validated.
- `ledger.card_lock(idx: int) -> threading.Lock` — lazily-created, one per idx, process-lifetime (Task 5 consumes this).

- [ ] **Step 1: Write the failing tests**

`server/tts-sidecar/tests/test_device_ledger.py`:
```python
import importlib, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


def _fake_torch(uuids=("GPU-0", "GPU-1")):
    def props(i):
        return types.SimpleNamespace(name=["RTX 4070", "RTX 5070 Ti"][i],
                                     total_memory=[8 * 10**9, 16 * 10**9][i], uuid=uuids[i])
    cuda = types.SimpleNamespace(
        is_available=lambda: True, device_count=lambda: 2,
        get_device_properties=props,
        mem_get_info=lambda i: ([6 * 10**9, 14 * 10**9][i], [8 * 10**9, 16 * 10**9][i]))
    return types.SimpleNamespace(cuda=cuda)


def test_ledger_sample_returns_card_row():
    ledger = main.DeviceLedger(_fake_torch())
    row = ledger.sample(1)
    assert row == {"uuid": "GPU-1", "idx": 1, "name": "RTX 5070 Ti", "total_mb": 16000, "free_mb": 14000}


def test_ledger_sample_none_for_out_of_range_idx():
    ledger = main.DeviceLedger(_fake_torch())
    assert ledger.sample(9) is None


def test_ledger_flags_vanished_on_uuid_mismatch():
    """A renumbered card (same idx, different physical GPU) must be reported as
    vanished (None), NEVER silently read as if it were the originally-seen card."""
    fake = _fake_torch()
    ledger = main.DeviceLedger(fake)
    assert ledger.sample(1)["uuid"] == "GPU-1"  # seeds known uuid at idx 1
    fake.cuda.get_device_properties = lambda i: types.SimpleNamespace(
        name="Different Card", total_memory=16 * 10**9, uuid="GPU-DIFFERENT")
    assert ledger.sample(1) is None


def test_ledger_sample_all_revalidates_every_card():
    ledger = main.DeviceLedger(_fake_torch())
    rows = ledger.sample_all()
    assert [r["idx"] for r in rows] == [0, 1]


def test_ledger_sample_all_empty_without_cuda():
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    ledger = main.DeviceLedger(fake)
    assert ledger.sample_all() == []


def test_ledger_card_lock_is_per_idx_and_stable():
    ledger = main.DeviceLedger(_fake_torch())
    lock0a = ledger.card_lock(0)
    lock0b = ledger.card_lock(0)
    lock1 = ledger.card_lock(1)
    assert lock0a is lock0b
    assert lock0a is not lock1


def test_ledger_sample_all_does_not_deadlock():
    """sample_all() must not call the public sample() (which re-acquires the
    lock) while already holding it — a naive implementation deadlocks here."""
    import threading
    ledger = main.DeviceLedger(_fake_torch())
    done = threading.Event()

    def worker():
        ledger.sample_all()
        done.set()

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout=2.0)
    assert done.is_set(), "sample_all() deadlocked"
```

- [ ] **Step 2: Run to verify it fails**

Run (from `server/tts-sidecar`): `.\.venv\Scripts\python.exe -m pytest tests/test_device_ledger.py -v`
Expected: FAIL — `main.DeviceLedger` undefined.

- [ ] **Step 3: Implement `DeviceLedger`**

Near `_enumerate_cuda_devices` (~3604), add:
```python
class DeviceLedger:
    """Thread-safe per-card VRAM reader wrapping the Wave-1 sampler
    (_sample_card). Read from three thread contexts (the _memory_watchdog
    asyncio loop, /health+/devices' sync threadpool threads, to_thread
    workers) — ONE threading.Lock serialises every sample so concurrent
    readers never race torch's CUDA context.

    NEVER caches an index across calls without re-validating it: every sample
    re-resolves get_device_properties(idx) and asserts its uuid still matches
    what was seen at that index on a PRIOR sample. A driver/OS renumber (rare,
    but explicitly called out by the spec) would otherwise have a cached idx
    silently read the WRONG physical card. A uuid mismatch reports the card as
    vanished (ceiling 0 downstream) — never silently substituted.

    CAVEAT (raised by a round-2 adversarial review, not fixed here — see Task
    9's on-box checklist): this guarantee depends on torch actually exposing
    a real per-card uuid via get_device_properties(idx).uuid. _sample_card
    (Wave 1, main.py ~3596) falls back to a synthetic f"idx-{idx}" string when
    that attribute is absent — on a torch build/driver where it's absent, the
    fallback uuid is DERIVED FROM THE INDEX ITSELF, so a renumber can never
    produce a mismatch and this detection silently no-ops. Confirm real uuids
    are present on the target box during Task 9's on-box acceptance before
    trusting this guarantee in production; if they're absent, this class's
    "never substitutes a renumbered card" claim only holds when torch exposes
    uuids, not unconditionally.

    `_sample_locked` factors the no-lock-acquisition body out of `sample`/
    `sample_all` so `sample_all` can loop calling it WITHOUT re-entering the
    (non-reentrant) lock — `sample_all` calling the public `sample()` while
    already holding `self._lock` would deadlock."""

    def __init__(self, torch_module: Any = None) -> None:
        self._lock = threading.Lock()
        self._torch_module = torch_module  # injectable for tests
        self._known_uuids: dict[int, str] = {}  # idx -> uuid last seen at that idx
        self._card_locks: dict[int, threading.Lock] = {}  # Task 5 consumes this

    def _torch(self) -> Any:
        if self._torch_module is not None:
            return self._torch_module
        import torch  # type: ignore
        return torch

    def _sample_locked(self, tm: Any, idx: int) -> Optional[dict]:
        """Body of sample(); caller MUST already hold self._lock."""
        try:
            if not tm.cuda.is_available() or idx >= tm.cuda.device_count():
                return None
            row = _sample_card(idx, tm)
        except Exception:
            return None
        seen = self._known_uuids.get(idx)
        if seen is None:
            self._known_uuids[idx] = row["uuid"]
        elif seen != row["uuid"]:
            return None  # renumbered — vanished, never substitute
        return row

    def sample(self, idx: int) -> Optional[dict]:
        with self._lock:
            return self._sample_locked(self._torch(), idx)

    def sample_all(self) -> list[dict]:
        with self._lock:
            tm = self._torch()
            try:
                n = tm.cuda.device_count() if tm.cuda.is_available() else 0
            except Exception:
                n = 0
            out = []
            for i in range(n):
                row = self._sample_locked(tm, i)
                if row is not None:
                    out.append(row)
            return out

    def card_lock(self, idx: int) -> threading.Lock:
        """Per-card mutex for a check-residency->evict->load sequence sharing
        this card (Task 5). Lazily created; one Lock per idx for the process
        lifetime — cards don't appear/disappear mid-process on a supported box."""
        with self._lock:
            lock = self._card_locks.get(idx)
            if lock is None:
                lock = threading.Lock()
                self._card_locks[idx] = lock
            return lock


_DEVICE_LEDGER = DeviceLedger()
```

- [ ] **Step 4: Run green**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_ledger.py -v`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_ledger.py
git commit -m "feat(sidecar): DeviceLedger — thread-safe per-card VRAM reader"
```

---

### Task 2: Driver-free floor + per-card ceiling (sidecar half, §W2.2)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `_sidecar_vram_free_floor_mb`, `_card_reserved_ceiling_mb`, `_check_per_card_ceilings` near `_vram_restart_threshold_mb` ~3641; wire into `_memory_watchdog`'s loop ~3837; extend `_schedule_restart_exit`'s signature with `card`; extend `_build_gpus_payload` with per-card ceiling fields)
- Modify (APPEND): `server/tts-sidecar/tests/test_devices.py`
- Create: `server/tts-sidecar/tests/test_per_card_ceilings.py`
- Modify: `server/src/config/registry.ts` (new `sidecar.vramFreeFloorMb` knob, Step 7)
- Regenerate: `server/.env.example` (via `npm run config:sync`, Step 7)

**Interfaces (consumed by Task 6):**
- `_sidecar_vram_free_floor_mb() -> float` — absolute per-card free-VRAM floor (MB); default 1024, override `SIDECAR_VRAM_FREE_FLOOR_MB`. **Absolute, not a fraction** — a fraction would self-satisfy on an idle low-VRAM card and never trip.
- `_check_per_card_ceilings(ledger: DeviceLedger, torch_module: Any = None) -> Optional[dict]` — `{"uuid","idx","reason"}` for the FIRST breaching card (OR rule: `free_mb < floor` OR this card's reserved crosses its own fraction ceiling), each independently freshly sampled. `None` when no card breaches.
- `_schedule_restart_exit(metric_mb, threshold_mb, metric_label="committed memory", card: Optional[dict] = None)` — `card` is `None` for the pre-existing host-RAM/device-0-VRAM triggers, and the breaching card's dict for a per-card trigger.

- [ ] **Step 1: Write the failing tests**

`server/tts-sidecar/tests/test_per_card_ceilings.py`:
```python
import importlib, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


def _fake_torch_with_reserved(free_mb, reserved_mb):
    def props(i):
        return types.SimpleNamespace(name="Card", total_memory=16 * 10**6 * 1000, uuid=f"GPU-{i}")
    cuda = types.SimpleNamespace(
        is_available=lambda: True, device_count=lambda: 1,
        get_device_properties=props,
        mem_get_info=lambda i: (free_mb * 1_000_000, 16000 * 1_000_000),
        memory_reserved=lambda i: reserved_mb * 1_000_000)
    return types.SimpleNamespace(cuda=cuda)


def test_free_floor_default_1024(monkeypatch):
    monkeypatch.delenv("SIDECAR_VRAM_FREE_FLOOR_MB", raising=False)
    assert main._sidecar_vram_free_floor_mb() == 1024.0


def test_free_floor_env_override(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "2048")
    assert main._sidecar_vram_free_floor_mb() == 2048.0


def test_check_per_card_ceilings_flags_floor_breach(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    tm = _fake_torch_with_reserved(free_mb=500, reserved_mb=100)  # free < floor
    ledger = main.DeviceLedger(tm)
    breach = main._check_per_card_ceilings(ledger, tm)
    assert breach == {"uuid": "GPU-0", "idx": 0, "reason": "driver_free_floor"}


def test_check_per_card_ceilings_flags_reserved_ceiling(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "100")  # low floor so it doesn't fire first
    tm = _fake_torch_with_reserved(free_mb=2000, reserved_mb=15700)  # reserved >= 0.98*16000
    ledger = main.DeviceLedger(tm)
    breach = main._check_per_card_ceilings(ledger, tm)
    assert breach == {"uuid": "GPU-0", "idx": 0, "reason": "reserved_vram_ceiling"}


def test_check_per_card_ceilings_none_when_healthy(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    tm = _fake_torch_with_reserved(free_mb=8000, reserved_mb=4000)
    ledger = main.DeviceLedger(tm)
    assert main._check_per_card_ceilings(ledger, tm) is None


def test_schedule_restart_exit_accepts_card(monkeypatch):
    """card= is a new optional kwarg — existing (no-card) callers keep working."""
    main._reset_restart_state_for_test()
    monkeypatch.setattr(main, "_drain_grace_ms", lambda: 0)
    monkeypatch.setattr(main.threading, "Thread", lambda target, args, daemon: types.SimpleNamespace(start=lambda: None))
    main._schedule_restart_exit(500.0, 400.0, "reserved VRAM", card={"uuid": "GPU-1", "idx": 1})
    assert main._last_restart_card == {"uuid": "GPU-1", "idx": 1}
```

Also append to `tests/test_devices.py` (the `_build_gpus_payload` shape gains two fields):
```python
def test_build_gpus_payload_includes_per_card_ceilings(monkeypatch):
    monkeypatch.setenv("SIDECAR_VRAM_FREE_FLOOR_MB", "1024")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {})
    out = main._build_gpus_payload(_fake_torch())
    assert out[0]["free_floor_mb"] == 1024.0
    assert out[0]["reserved_ceiling_mb"] == main._VRAM_HARD_FRACTION * 16000
```
(`_fake_torch` here is the one already defined earlier in `test_devices.py` from Wave 1 — reuse it, don't redefine.)

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_per_card_ceilings.py -v` and `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -k per_card_ceilings -v`
Expected: FAIL — all three new symbols undefined; `_schedule_restart_exit` rejects the `card` kwarg (TypeError); `_build_gpus_payload` output lacks the two new keys.

- [ ] **Step 3: Implement the floor + per-card ceiling check**

Near `_vram_restart_threshold_mb` (~3641):
```python
def _sidecar_vram_free_floor_mb() -> float:
    """Absolute per-card free-VRAM floor (MB) — the ONLY OOM guard for an
    ORT/CT2-only card (Kokoro/Whisper), which never shows up in torch's
    reserved-memory metric. Deliberately ABSOLUTE, not a fraction: a
    fraction-based floor would self-satisfy on an idle low-VRAM display card
    and never trip. Default 1024 MB (Round 5 decision — tune during Wave 2
    on-box acceptance, not before); override SIDECAR_VRAM_FREE_FLOOR_MB."""
    env = os.environ.get("SIDECAR_VRAM_FREE_FLOOR_MB")
    if env is not None:
        try:
            return float(env)
        except (TypeError, ValueError):
            pass
    return 1024.0


def _card_reserved_ceiling_mb(total_mb: float) -> float:
    """Per-card reserved-VRAM HARD ceiling — the same _VRAM_HARD_FRACTION
    already used for the device-0 scalar ceiling, applied per-card."""
    return _VRAM_HARD_FRACTION * total_mb if total_mb and total_mb > 0 else 0.0


def _check_per_card_ceilings(ledger: "DeviceLedger", torch_module: Any = None) -> Optional[dict]:
    """OR-rule per-card breach: for each visible card, freshly sampled via the
    ledger, breach if EITHER free_mb < the absolute floor OR (torch-only)
    reserved VRAM crosses THIS card's own fraction ceiling. Returns the FIRST
    breaching card's {uuid, idx, reason}, or None. Each card's readings are
    independently fresh — never a stale/cached value from another card's check."""
    floor = _sidecar_vram_free_floor_mb()
    for card in ledger.sample_all():
        if card["free_mb"] < floor:
            return {"uuid": card["uuid"], "idx": card["idx"], "reason": "driver_free_floor"}
        try:
            tm = torch_module
            if tm is None:
                import torch as tm  # type: ignore
            reserved = tm.cuda.memory_reserved(card["idx"]) / 1_000_000.0
            ceiling = _card_reserved_ceiling_mb(card["total_mb"])
            if ceiling > 0 and reserved >= ceiling:
                return {"uuid": card["uuid"], "idx": card["idx"], "reason": "reserved_vram_ceiling"}
        except Exception:
            pass
    return None
```

- [ ] **Step 4: Thread `card` through `_schedule_restart_exit` + wire the watchdog**

`_schedule_restart_exit` (main.py:3768) — change the signature and add the module global:
```python
_last_restart_card: Optional[dict] = None


def _schedule_restart_exit(
    metric_mb: float, threshold_mb: float, metric_label: str = "committed memory",
    card: Optional[dict] = None,
) -> None:
    global _restart_scheduled, _restart_pending, _last_restart_card
    if _restart_scheduled:
        return
    _restart_scheduled = True
    _restart_pending = True
    _last_restart_card = card
    grace_ms = _drain_grace_ms()
    log.warning(
        "sidecar %s %.0fMB crossed the restart ceiling %.0fMB%s — "
        "draining %d in-flight synth (grace %dms) then self-exiting (code %d) so the "
        "server respawns a fresh process. Completed chapters are skipped (srv-16); "
        "the in-flight chapter finishes here or is re-rendered by the server "
        "(srv-17c). Raise the ceiling to recycle less often.",
        metric_label, metric_mb, threshold_mb,
        f" (card {card['idx']})" if card else "",
        _inflight_synth, grace_ms, _RESTART_EXIT_CODE,
    )
    threading.Thread(target=_drain_then_restart, args=(grace_ms,), daemon=True).start()
```
(Only the signature, the new global, and the log line's card suffix change — the rest of the function body is unchanged from what's already there.)

Add a test-only reset helper next to the existing `_reset_poison_for_test` (~431):
```python
def _reset_restart_state_for_test() -> None:
    """Test-only: clear restart-scheduling state so cases don't bleed."""
    global _restart_scheduled, _restart_pending, _last_restart_card
    _restart_scheduled = False
    _restart_pending = False
    _last_restart_card = None
```

In `_memory_watchdog` (~3837), after the existing device-0 VRAM hard-ceiling check and before the soft-recycle checks, add the per-card check:
```python
            if vram_reserved is not None and _should_restart(vram_reserved, vram_hard):
                _schedule_restart_exit(vram_reserved, vram_hard, "reserved VRAM")
                continue
            per_card_breach = _check_per_card_ceilings(_DEVICE_LEDGER)
            if per_card_breach is not None:
                _schedule_restart_exit(
                    0.0, 0.0, f"card {per_card_breach['idx']} {per_card_breach['reason']}",
                    card=per_card_breach,
                )
                continue
```
(Inserted immediately after the existing `if vram_reserved is not None and _should_restart(...)` block you already read at Step-1-research time — re-`grep -n "_schedule_restart_exit(vram_reserved" main.py` to confirm the exact current line before editing, since Task 2/6 of this plan haven't landed yet when you start.)

- [ ] **Step 5: Extend `_build_gpus_payload` with per-card ceiling fields**

In `_build_gpus_payload` (main.py ~4344, the `for c in cards: c["torch_reserved_mb"] = ...` loop), add two more fields in the same loop:
```python
    for c in cards:
        c["torch_reserved_mb"] = round(...)  # existing line, unchanged
        c["free_floor_mb"] = _sidecar_vram_free_floor_mb()
        c["reserved_ceiling_mb"] = _card_reserved_ceiling_mb(c["total_mb"])
```

- [ ] **Step 6: Run green**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_per_card_ceilings.py tests/test_devices.py -v`
Expected: PASS.

- [ ] **Step 7: Add the new registry knob (so it's `apply:'restart-sidecar'`-injected automatically)**

Modify `server/src/config/registry.ts` — add near the other `tts.*`/`sidecar.*` knobs:
```ts
  {
    key: 'sidecar.vramFreeFloorMb',
    env: 'SIDECAR_VRAM_FREE_FLOOR_MB',
    group: 'tts-engine',
    label: 'Per-card VRAM free floor (MB)',
    help: 'Absolute free-VRAM headroom below which a card is treated as critically low and the sidecar recycles. The only OOM guard for Kokoro/Whisper (their VRAM is invisible to the torch-reserved metric). Default 1024MB.',
    type: 'integer',
    default: 1024,
    min: 0,
    apply: 'restart-sidecar', risk: 'medium',
  },
```
No Node-side read site is needed beyond this — `buildSidecarEnv()` (`spawn-sidecar.ts:422-500`) already loops every `apply==='restart-sidecar'` knob and injects `env[knob.env] = String(st.effective)` generically (verified at plan-authoring time — no per-knob Node code required).

Run (repo root): `npm run config:sync && npm run config:check` — expected PASS, `.env.example` gains `SIDECAR_VRAM_FREE_FLOOR_MB`.

- [ ] **Step 8: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_per_card_ceilings.py server/tts-sidecar/tests/test_devices.py server/src/config/registry.ts server/.env.example
git commit -m "feat(sidecar,server): per-card driver-free floor + reserved-VRAM ceiling"
```

---

### Task 3: Per-card ceiling reconcile — Node side (§W2.2 continued)

**Files:**
- Modify: `server/src/tts/spawn-sidecar.ts` (`SidecarHealthProbe` interface ~174-200; `probeSidecarHealth` parsing ~206-252; `sidecarCeilingMismatch` ~149-160)
- Modify (APPEND): `server/src/tts/spawn-sidecar.test.ts`

**Interfaces (consumed by nothing further in this plan — a diagnostics-only reconcile, matching the existing scalar `sidecarCeilingMismatch` contract):**
- `SidecarHealthProbe.gpus?: Array<{ idx: number; freeFloorMb: number | null }>` — parsed from the sidecar's `/health` `gpus[]` (Task 2 added `free_floor_mb` there).
- `sidecarCeilingMismatch` gains a per-card free-floor comparison alongside its existing two scalar comparisons.

- [ ] **Step 1: Append the failing tests**

Append to `server/src/tts/spawn-sidecar.test.ts` (read its existing `sidecarCeilingMismatch` describe block first — `grep -n "sidecarCeilingMismatch" server/src/tts/spawn-sidecar.test.ts` — and match its mocking style for `expectedSidecarCeilings`/`allKnobs`/`resolveKnob`):
```ts
describe('sidecarCeilingMismatch — per-card free floor', () => {
  it('flags a card whose reported free-floor disagrees with the configured knob', () => {
    // Arrange the SAME way the existing scalar-mismatch tests in this file do
    // (mock resolveKnob for 'sidecar.vramFreeFloorMb' to a NON-default source
    // so expectedSidecarCeilings() treats it as a real expectation) — read the
    // existing tests immediately above this block before writing the mock.
    const health = {
      memRestartMb: null, vramRestartMb: null,
      gpus: [{ idx: 0, freeFloorMb: 2048 }], // sidecar reports 2048, config expects 1024
    } as any;
    expect(sidecarCeilingMismatch(health)).toMatch(/free.?floor/i);
  });

  it('is null when every reported card free-floor matches (or no expectation is configured)', () => {
    const health = { memRestartMb: null, vramRestartMb: null, gpus: [{ idx: 0, freeFloorMb: null }] } as any;
    expect(sidecarCeilingMismatch(health)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/tts/spawn-sidecar.test.ts -t "per-card free floor"`
Expected: FAIL — `health.gpus` isn't read by `sidecarCeilingMismatch` at all yet, so the first case never matches.

- [ ] **Step 3: Extend the type, the parser, and the mismatch check**

`SidecarHealthProbe` (174-200) — add one field:
```ts
  /** Per-card free-VRAM floor as reported by /health gpus[] (Wave 2 §W2.2).
      Absent on an older sidecar or when CUDA is unavailable. */
  gpus?: Array<{ idx: number; freeFloorMb: number | null }>;
```

`probeSidecarHealth` (206-252) — after the existing `memRestartMb`/`vramRestartMb` parse lines, add:
```ts
    const gpusRaw = Array.isArray(body.gpus) ? body.gpus : [];
    const gpus = gpusRaw
      .filter((g): g is Record<string, unknown> => typeof g === 'object' && g !== null)
      .map((g) => ({
        idx: typeof g.idx === 'number' ? g.idx : -1,
        freeFloorMb: typeof g.free_floor_mb === 'number' ? g.free_floor_mb : null,
      }));
    return { reachable: true, looksLikeSidecar, protocolVersion, committedMb, recyclePending, memRestartMb, vramRestartMb, gpus };
```
(Add `gpus` to BOTH return statements in the try block — the ok-but-non-parseable early return at line ~217-223 can omit it, matching how that branch already omits `memRestartMb`/`vramRestartMb`.)

`sidecarCeilingMismatch` (149-160) — add a per-card check reusing the existing `off()` helper:
```ts
export function sidecarCeilingMismatch(health: SidecarHealthProbe): string | null {
  const expected = expectedSidecarCeilings();
  const off = (exp: number | null, got: number | null | undefined): boolean =>
    exp !== null && typeof got === 'number' && Math.abs(got - exp) > 1;
  if (off(expected.memRestartMb, health.memRestartMb)) {
    return `committed-RAM recycle ceiling ${Math.round(health.memRestartMb!)}MB != configured ${expected.memRestartMb}MB`;
  }
  if (off(expected.vramRestartMb, health.vramRestartMb)) {
    return `reserved-VRAM recycle ceiling ${Math.round(health.vramRestartMb!)}MB != configured ${expected.vramRestartMb}MB`;
  }
  const expectedFloor = expectedFreeFloorMb();
  for (const g of health.gpus ?? []) {
    if (off(expectedFloor, g.freeFloorMb)) {
      return `card ${g.idx} free-VRAM floor ${g.freeFloorMb}MB != configured ${expectedFloor}MB`;
    }
  }
  return null;
}
```
Add `expectedFreeFloorMb()` next to `expectedSidecarCeilings()` (123-142), same pattern:
```ts
export function expectedFreeFloorMb(): number | null {
  const knob = allKnobs().find((k) => k.key === 'sidecar.vramFreeFloorMb');
  if (!knob) return null;
  const st = resolveKnob(knob);
  if (st.source === 'default') return null;
  const n = Number(st.effective);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
```

- [ ] **Step 4: Run green**

Run: `cd server && npx vitest run src/tts/spawn-sidecar.test.ts`
Expected: PASS (all cases including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/spawn-sidecar.ts server/src/tts/spawn-sidecar.test.ts
git commit -m "feat(server): per-card free-floor ceiling reconcile against /health gpus[]"
```

---

### Task 4: `shares_device` coupling + gate the VD/Kokoro arbiter (§W2.3)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `shares_device` near `_resolve_torch_device` ~1412; modify `_VdKokoroArbiter.__init__`/`kokoro_synth`/`design` ~585-634; add `_compute_vd_kokoro_shares_device` + a startup hook)
- Modify (APPEND): `server/tts-sidecar/tests/test_design_kokoro_exclusion.py` (the existing file already instantiates `_VdKokoroArbiter` directly per fresh-instance-per-test — reuse that pattern)

**Interfaces (consumed by Task 5):**
- `shares_device(device_a: Optional[str], device_b: Optional[str], torch_module: Any = None) -> bool` — resolves `'auto'` via the EXISTING `_resolve_torch_device` (both engines left at `'auto'` correctly share whichever card auto picks, rather than reading as never-coupled); `cpu`/`mps` never "share" (no VRAM contention to guard); two `cuda:N` values share iff same index (unindexed `'cuda'` treated as index 0).
- `_VdKokoroArbiter(shares_device: bool = True)` — default `True` preserves today's always-coupled behaviour (safe on a single-card box); `kokoro_synth()`/`design()` become no-ops (`yield` immediately, no lock) when `False`.

- [ ] **Step 1: Write the failing tests**

Append near the top of `server/tts-sidecar/tests/test_design_kokoro_exclusion.py` (after its existing imports — read the file first to match its `_VdKokoroArbiter` import style):
```python
def _fake_torch_cuda_available():
    return types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True))


def test_shares_device_same_explicit_index():
    tm = _fake_torch_cuda_available()
    assert main.shares_device("cuda:1", "cuda:1", tm) is True


def test_shares_device_different_index():
    tm = _fake_torch_cuda_available()
    assert main.shares_device("cuda:0", "cuda:1", tm) is False


def test_shares_device_both_auto_resolve_same_card():
    tm = _fake_torch_cuda_available()
    assert main.shares_device("auto", "auto", tm) is True


def test_shares_device_cpu_never_shares():
    tm = _fake_torch_cuda_available()
    assert main.shares_device("cpu", "cpu", tm) is False
    assert main.shares_device("cpu", "cuda:0", tm) is False


def test_arbiter_coupled_by_default_blocks_kokoro_during_design():
    """Existing behaviour (single-card box) unchanged when shares_device isn't passed."""
    arb = main._VdKokoroArbiter()
    entered_design = threading.Event()
    kokoro_blocked_until = threading.Event()

    def do_design():
        with arb.design():
            entered_design.set()
            kokoro_blocked_until.wait(timeout=1.0)

    t = threading.Thread(target=do_design)
    t.start()
    entered_design.wait(timeout=1.0)
    # A kokoro_synth() call started AFTER design is active must block until design exits.
    acquired = threading.Event()

    def do_kokoro():
        with arb.kokoro_synth():
            acquired.set()

    t2 = threading.Thread(target=do_kokoro)
    t2.start()
    assert not acquired.wait(timeout=0.3)  # still blocked
    kokoro_blocked_until.set()
    t.join(timeout=1.0)
    assert acquired.wait(timeout=1.0)
    t2.join(timeout=1.0)


def test_arbiter_uncoupled_kokoro_runs_freely_during_design():
    """shares_device=False (different cards) → no coupling at all."""
    arb = main._VdKokoroArbiter(shares_device=False)
    with arb.design():
        acquired = threading.Event()

        def do_kokoro():
            with arb.kokoro_synth():
                acquired.set()

        t = threading.Thread(target=do_kokoro)
        t.start()
        assert acquired.wait(timeout=1.0)  # NOT blocked — different cards
        t.join(timeout=1.0)


def test_compute_vd_kokoro_shares_device_reads_env(monkeypatch):
    monkeypatch.setenv("QWEN_DEVICE", "cuda:0")
    monkeypatch.setenv("KOKORO_DEVICE", "cuda:1")
    monkeypatch.setattr(main, "shares_device", lambda a, b, tm=None: a == "cuda:0" and b == "cuda:0")
    assert main._compute_vd_kokoro_shares_device() is False


def test_compute_vd_kokoro_shares_device_defaults_true_on_error(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("no torch")
    monkeypatch.setattr(main, "shares_device", boom)
    assert main._compute_vd_kokoro_shares_device() is True
```
(`threading` and `types` must already be imported at the top of this test file — Wave 1's `test_design_kokoro_exclusion.py` already imports `threading` per the earlier research pass; add `import types` if it's not already there.)

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_design_kokoro_exclusion.py -k "shares_device or uncoupled" -v`
Expected: FAIL — `shares_device`/`_compute_vd_kokoro_shares_device` undefined; `_VdKokoroArbiter()` rejects the `shares_device` kwarg.

- [ ] **Step 3: Implement `shares_device`**

Near `_resolve_torch_device` (~1412):
```python
def shares_device(device_a: Optional[str], device_b: Optional[str], torch_module: Any = None) -> bool:
    """True when two device knob values resolve to the SAME concrete card.
    'auto' resolves via the existing _resolve_torch_device (every engine
    shares Wave 1's device grammar) so two engines both left at 'auto' are
    correctly treated as sharing whichever card auto picks — not as
    never-coupled. cpu/mps never "share" in the VRAM-contention sense this
    gates (only cuda:N contention matters)."""
    if torch_module is None:
        import torch as torch_module  # type: ignore
    resolved_a = _resolve_torch_device(device_a or "auto", torch_module)
    resolved_b = _resolve_torch_device(device_b or "auto", torch_module)
    fam_a, idx_a = _parse_device(resolved_a)
    fam_b, idx_b = _parse_device(resolved_b)
    if fam_a != "cuda" or fam_b != "cuda":
        return False
    return (idx_a or 0) == (idx_b or 0)


def _compute_vd_kokoro_shares_device() -> bool:
    """Resolve whether QWEN_DEVICE and KOKORO_DEVICE currently share a card.
    Any failure (no torch, unreadable env) defaults True — the SAFE,
    conservative choice (stay coupled) rather than silently disabling the
    guard on an error."""
    try:
        return shares_device(os.environ.get("QWEN_DEVICE"), os.environ.get("KOKORO_DEVICE"))
    except Exception:
        return True
```

- [ ] **Step 4: Gate the arbiter on `shares_device`**

Replace the `_VdKokoroArbiter` class (585-634):
```python
class _VdKokoroArbiter:
    """Mutual exclusion between a VoiceDesign forward and Kokoro synths —
    ONLY when the two are configured onto the SAME card (`shares_device`,
    Wave 2 §W2.3). On a single-card box (the default) they always share, so
    behaviour is unchanged from Wave 1. On a multi-GPU box with Kokoro pinned
    to a different card than Qwen, there's no VRAM contention to guard and
    the two run fully concurrently — `kokoro_synth()`/`design()` become
    no-op context managers in that case.

    [... existing docstring body about the drain-and-lock policy unchanged ...]
    """

    def __init__(self, shares_device: bool = True) -> None:
        self._cv = threading.Condition()
        self._kokoro_in_flight = 0
        self._design_active = False
        self._shares_device = shares_device

    @contextmanager
    def kokoro_synth(self):
        if not self._shares_device:
            yield
            return
        with self._cv:
            while self._design_active:
                self._cv.wait()
            self._kokoro_in_flight += 1
        try:
            yield
        finally:
            with self._cv:
                self._kokoro_in_flight -= 1
                self._cv.notify_all()

    @contextmanager
    def design(self):
        if not self._shares_device:
            yield
            return
        with self._cv:
            while self._kokoro_in_flight > 0:
                self._cv.wait()
            self._design_active = True
        try:
            yield
        finally:
            with self._cv:
                self._design_active = False
                self._cv.notify_all()


_VD_KOKORO = _VdKokoroArbiter()


@app.on_event("startup")
async def _configure_vd_kokoro_coupling() -> None:
    """Resolve the real QWEN_DEVICE/KOKORO_DEVICE coupling at startup (not at
    module import time — torch must stay a lazily-imported dependency so
    tests that stub it via sys.modules injection, not module-attribute
    patching, keep working per the sidecar's own testing convention)."""
    _VD_KOKORO._shares_device = _compute_vd_kokoro_shares_device()
```

- [ ] **Step 5: Run green**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_design_kokoro_exclusion.py -v`
Expected: PASS (existing tests in this file AND the new ones — the existing tests construct their own fresh `_VdKokoroArbiter()` instances per the file's established pattern, which now default to `shares_device=True` and are therefore unaffected).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_design_kokoro_exclusion.py
git commit -m "feat(sidecar): shares_device coupling — VD/Kokoro arbiter only guards same-card pins"
```

---

### Task 5: Per-card load/evict mutex for non-VD/Kokoro same-card pairs (§W2.4)

**Files:**
- Modify: `server/tts-sidecar/main.py` (wire `_DEVICE_LEDGER.card_lock(idx)` around the QwenEngine design-load path that already combines `_base17_activity()` + `_VD_KOKORO.design()`)
- Modify (APPEND): `server/tts-sidecar/tests/test_device_ledger.py`

**Why scoped to this one call site:** per the research pass, EVERY engine's `/load` route (main.py 4602-4685) already serialises via its OWN per-engine `asyncio.Lock` (`_load_lock`) — that prevents a TOCTOU within one engine's own load, but NOT between two DIFFERENT engines sharing a card (e.g. Coqui pinned `cuda:1` + ASR pinned `cuda:1`, both loading around the same moment). The `_VD_KOKORO` arbiter (Task 4) already covers the Qwen VoiceDesign ↔ Kokoro pair specifically. This task adds the GENERAL per-card mutex the ledger now exposes (`card_lock`, Task 1) and wires it at the one site the spec calls out explicitly (`design()` also holding the per-card mutex, spec §W2.3's lock-ordering note) — **any other same-card pair (e.g. Coqui+ASR) is a real gap left for the implementer to wire identically at that pair's load sites if/when it's hit on-box; this task establishes the primitive and its ONE proven call site, not an exhaustive sweep of every engine pairing (YAGNI — wire the rest only once a real multi-engine same-card assignment is actually configured on the box).**

**Fixed lock order (must be followed everywhere `card_lock` and `_VD_KOKORO` are both held):** acquire the per-card mutex FIRST, then enter `_VD_KOKORO.design()`/`.kokoro_synth()`. Never the reverse — a call site that acquired them in the opposite order would deadlock against this one.

- [ ] **Step 1: Append the failing test**

Append to `test_device_ledger.py`:
```python
def test_card_lock_serialises_two_threads_on_same_idx():
    ledger = main.DeviceLedger(_fake_torch())
    order = []

    def worker(name, hold_ms):
        with ledger.card_lock(1):
            order.append(f"{name}-start")
            time.sleep(hold_ms / 1000.0)
            order.append(f"{name}-end")

    t1 = threading.Thread(target=worker, args=("a", 100))
    t2 = threading.Thread(target=worker, args=("b", 0))
    t1.start()
    time.sleep(0.02)  # ensure t1 has the lock first
    t2.start()
    t1.join(timeout=2.0)
    t2.join(timeout=2.0)
    # b must not start until a has fully finished — proves serialisation, not just mutual presence.
    assert order == ["a-start", "a-end", "b-start", "b-end"]
```
(`threading` and `time` must be imported at the top of `test_device_ledger.py` — add if missing.)

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_ledger.py -k card_lock -v`
Expected: PASS already for the basic per-idx-identity test from Task 1 — this NEW test specifically proves serialisation ordering, which `card_lock`'s Task-1 implementation already provides (it returns a real `threading.Lock`). Confirm it passes as-is; if it doesn't, `card_lock` from Task 1 has a bug — fix there, not here.

- [ ] **Step 3: Add a testable `_qwen_configured_card_idx()` helper and wire it at the QwenEngine design-load call site**

Extracted as its own function (rather than an inline expression) specifically so Task 10.5 can update ONE well-defined place once Plan 2's UUID resolver exists, instead of hunting for an inline snippet buried in a `with` statement:
```python
def _qwen_configured_card_idx() -> int:
    """Best-effort resolved card index for QWEN_DEVICE, used to pick the
    per-card mutex the 1.7B-Base design-load path acquires (Task 5). Wave 2
    reads the raw env directly — Plan 2's UUID resolver (_read_device_env)
    doesn't exist yet at this point in the build order. Task 10.5 upgrades
    this function to route through _read_device_env once it does; DO NOT
    read raw env at any OTHER new call site without checking Task 10.5's
    note first."""
    fam, idx = _parse_device(os.environ.get("QWEN_DEVICE", "auto"))
    return idx or 0
```
Place it near `_resolve_torch_device`/`shares_device` (Task 4's location, ~1412+the new `shares_device` block).

`grep -n "_base17_activity(), _VD_KOKORO.design()"` main.py` to confirm the current exact line (was ~2565 at research time). Change:
```python
        with self._base17_activity(), _VD_KOKORO.design():
```
to:
```python
        with _DEVICE_LEDGER.card_lock(_qwen_configured_card_idx()), self._base17_activity(), _VD_KOKORO.design():
```

- [ ] **Step 4: Run the full design-exclusion + ledger suites green**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_ledger.py tests/test_design_kokoro_exclusion.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_ledger.py
git commit -m "feat(sidecar): per-card mutex around the Qwen 1.7B design-load path"
```

---

### Task 6: code-43 streak — sidecar plumbs the offending card to disk (§W2.5, sidecar half)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `_write_restart_breadcrumb`, called from `_schedule_restart_exit`)
- Modify (APPEND): `server/tts-sidecar/tests/test_per_card_ceilings.py`

**Why a file, not an in-memory field `/health` exposes:** `onChildExit(code, signal)` (`sidecar-supervisor.ts:258`) — the ONLY Node-side signal that a child has exited — fires AFTER the process is already dead; there is no window to poll a dying process's `/health` reliably before it vanishes. A small breadcrumb file, written synchronously BEFORE the drain thread starts (so it's on disk well before the process could exit), lets the NEXT process boundary — the Node supervisor, in Task 7 — read it after the fact. This is the literal "the sidecar must plumb the offending card into its self-exit" from the spec.

**Interfaces (consumed by Task 7):**
- `_write_restart_breadcrumb(card: Optional[dict], metric_label: str) -> None` — best-effort (never raises into the caller); writes `server/tts-sidecar/.run/last-restart-trip.json` = `{"card": ..., "reason": ..., "residentEngines": [...], "ts": <unix time>}`.

- [ ] **Step 1: Append the failing test**

```python
def test_write_restart_breadcrumb_persists_card(tmp_path, monkeypatch):
    breadcrumb = tmp_path / ".run" / "last-restart-trip.json"
    monkeypatch.setattr(main, "_RESTART_BREADCRUMB_PATH", str(breadcrumb))
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {1: [{"engine": "coqui", "actual_card": 1}]})
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    main._write_restart_breadcrumb({"uuid": "GPU-1", "idx": 1}, "reserved VRAM")
    import json
    body = json.loads(breadcrumb.read_text(encoding="utf-8"))
    assert body["card"] == {"uuid": "GPU-1", "idx": 1}
    assert body["reason"] == "reserved VRAM"
    assert body["residentEngines"] == ["coqui"]
    assert "ts" in body


def test_write_restart_breadcrumb_never_raises_on_failure(monkeypatch):
    monkeypatch.setattr(main, "_RESTART_BREADCRUMB_PATH", "/definitely/not/a/writable/path/x.json")
    main._write_restart_breadcrumb(None, "committed memory")  # must not raise


def test_schedule_restart_exit_writes_breadcrumb(tmp_path, monkeypatch):
    main._reset_restart_state_for_test()
    breadcrumb = tmp_path / "trip.json"
    monkeypatch.setattr(main, "_RESTART_BREADCRUMB_PATH", str(breadcrumb))
    monkeypatch.setattr(main, "_drain_grace_ms", lambda: 0)
    monkeypatch.setattr(main.threading, "Thread", lambda target, args, daemon: types.SimpleNamespace(start=lambda: None))
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {})
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    main._schedule_restart_exit(500.0, 400.0, "reserved VRAM", card={"uuid": "GPU-1", "idx": 1})
    assert breadcrumb.exists()
```

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_per_card_ceilings.py -k breadcrumb -v`
Expected: FAIL — `_write_restart_breadcrumb`/`_RESTART_BREADCRUMB_PATH` undefined.

- [ ] **Step 3: Implement**

Near `_schedule_restart_exit` (main.py, added in Task 2):
```python
_RESTART_BREADCRUMB_PATH = os.path.join(os.path.dirname(__file__), ".run", "last-restart-trip.json")


def _write_restart_breadcrumb(card: Optional[dict], metric_label: str) -> None:
    """Best-effort persisted trip info so the NODE SUPERVISOR (a separate,
    longer-lived process) can learn WHICH CARD triggered a code-43 self-exit —
    onChildExit only gets (code, signal), no card. Written synchronously
    BEFORE the drain thread starts, so it's on disk well before this process
    can vanish. A write failure here must never block the exit path — logged
    and swallowed, since Plan 2's auto-revert simply lacks card info for that
    one trip if it can't be written."""
    try:
        os.makedirs(os.path.dirname(_RESTART_BREADCRUMB_PATH), exist_ok=True)
        resident = []
        if card is not None:
            by_card = _resident_engines_by_card(_enumerate_cuda_devices())
            resident = [r["engine"] for r in by_card.get(card["idx"], [])]
        with open(_RESTART_BREADCRUMB_PATH, "w", encoding="utf-8") as f:
            json.dump({"card": card, "reason": metric_label, "residentEngines": resident, "ts": time.time()}, f)
    except Exception as e:
        log.warning("could not write restart breadcrumb (%s) — a downstream auto-revert will lack card info for this trip.", e)
```
(`json` must already be imported at the top of `main.py` — it's used extensively elsewhere; if not, add `import json`.)

In `_schedule_restart_exit`, add ONE line right after `_last_restart_card = card`:
```python
    _last_restart_card = card
    _write_restart_breadcrumb(card, metric_label)
```

- [ ] **Step 4: Run green**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_per_card_ceilings.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_per_card_ceilings.py
git commit -m "feat(sidecar): persist a restart-trip breadcrumb (card + resident engines) before self-exit"
```

---

### Task 7: code-43 streak guard — Node supervisor counts across restarts, holds TTS down (§W2.5, Node half)

**Files:**
- Modify: `server/src/tts/sidecar-supervisor.ts` (add a code-43-specific streak counter independent of the existing `consecutiveFailures`/backoff logic; expose `tripEvent()` on the `SidecarSupervisor` interface)
- Create: `server/src/tts/restart-breadcrumb.ts` (reads the sidecar's persisted trip file)
- Modify (APPEND): `server/src/tts/sidecar-supervisor.test.ts`
- Create: `server/src/tts/restart-breadcrumb.test.ts`

**Why a SEPARATE counter from `consecutiveFailures`:** the existing counter (`sidecar-supervisor.ts:262-263`) resets to 0 whenever a child `lived >= QUICK_DEATH_MS` (30s) — so a structurally-too-small assignment that loads fine for 35s and THEN dies every time would never trip the existing give-up branch (it keeps resetting). A code-43-specific streak that counts REGARDLESS of `lived`, exactly as the spec's §W2.5 calls for, catches that case.

**Interfaces (consumed by Task 16, Plan 2's auto-revert):**
- `readRestartBreadcrumb(): { card: unknown; reason: string; residentEngines: string[] } | null` — best-effort sync file read.
- `SidecarSupervisor.tripEvent(): { card: unknown; residentEngines: string[] } | null` — non-null once the code-43 streak has tripped; supervisor no longer respawns once tripped (TTS held down, matching the existing give-up branch's "TTS is DOWN" behaviour).

- [ ] **Step 1: Write `restart-breadcrumb.ts` + its failing test**

`server/src/tts/restart-breadcrumb.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { readRestartBreadcrumb } from './restart-breadcrumb.js';

describe('readRestartBreadcrumb', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses a valid breadcrumb file', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'], ts: 123 }),
    );
    expect(readRestartBreadcrumb()).toEqual({
      card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'],
    });
  });

  it('returns null when the file is missing', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readRestartBreadcrumb()).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('not json');
    expect(readRestartBreadcrumb()).toBeNull();
  });
});
```

Run: `cd server && npx vitest run src/tts/restart-breadcrumb.test.ts` → FAIL (module doesn't exist).

`server/src/tts/restart-breadcrumb.ts`:
```ts
/* Reads the breadcrumb the sidecar persists (server/tts-sidecar/main.py,
   _write_restart_breadcrumb) right before a code-43 self-exit — the ONLY way
   the Node supervisor can learn which card triggered a restart, since
   onChildExit(code, signal) carries neither (Wave 2 §W2.5). */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BREADCRUMB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'tts-sidecar', '.run', 'last-restart-trip.json',
);

export interface RestartBreadcrumb {
  card: unknown;
  reason: string;
  residentEngines: string[];
}

/** Best-effort read of the sidecar's last-restart-trip breadcrumb. Returns
    null on any failure (missing file, malformed JSON) — the caller treats a
    trip with no card info as a degraded-but-still-valid trip. */
export function readRestartBreadcrumb(): RestartBreadcrumb | null {
  try {
    const body = JSON.parse(readFileSync(BREADCRUMB_PATH, 'utf-8')) as Record<string, unknown>;
    return {
      card: body.card ?? null,
      reason: typeof body.reason === 'string' ? body.reason : 'unknown',
      residentEngines: Array.isArray(body.residentEngines) ? (body.residentEngines as string[]) : [],
    };
  } catch {
    return null;
  }
}
```
> Verify `BREADCRUMB_PATH`'s relative segment count against the ACTUAL compiled output location (`server/dist/tts/restart-breadcrumb.js` vs `server/tts-sidecar/.run/...`) before trusting it — run `node -e "console.log(require('path').join(__dirname,'..','..','..','tts-sidecar','.run','last-restart-trip.json'))"` from the compiled `dist/tts/` dir once the build exists, or simpler: compute it from a known-stable anchor (`process.cwd()`-relative assumes the server always launches from repo root, which — confirm against how `getResolvedSidecarUrl`/other sidecar-path code in `workspace/user-settings.ts` resolves the sidecar directory, and mirror THAT pattern instead of a `import.meta.url`-relative guess if it differs).

Run: `cd server && npx vitest run src/tts/restart-breadcrumb.test.ts` → PASS (the test mocks `fs.readFileSync` directly, so the exact path resolution doesn't affect these particular test cases — but gets it right for on-box Task 9 acceptance).

- [ ] **Step 2: Append the failing supervisor test**

Append to `server/src/tts/sidecar-supervisor.test.ts` (match its existing `makeSpawn`/injected-`nowFn` pattern — read the top of the file for the exact helper shape before writing):
```ts
describe('code-43 streak guard (independent of the lived-based backoff reset)', () => {
  it('trips after 3 code-43 exits within 10 minutes even when each child lived past QUICK_DEATH_MS', async () => {
    let now = 0;
    const nowFn = () => now;
    const delays: number[] = [];
    const delayFn = async (ms: number) => { delays.push(ms); };
    vi.spyOn(breadcrumbModule, 'readRestartBreadcrumb').mockReturnValue({
      card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'],
    });
    const spawn = makeSpawn(); // existing test helper — captures onExit as spawn.exit(code)
    const supervisor = createSidecarSupervisor({
      buildOpts: async () => ({}) as any,
      spawnFn: spawn.fn, nowFn, delayFn, log: vi.fn(), warn: vi.fn(),
    });
    await supervisor.start();
    for (let i = 0; i < 3; i++) {
      now += 35_000; // each child "lived" 35s — well past QUICK_DEATH_MS (30s), resets consecutiveFailures
      spawn.exit(43);
      await Promise.resolve(); // let the async onChildExit body settle
    }
    expect(supervisor.tripEvent()).toEqual({ card: { uuid: 'GPU-1', idx: 1 }, residentEngines: ['coqui'] });
  });

  it('does not trip on 3 non-43 exits', async () => {
    let now = 0;
    const spawn = makeSpawn();
    const supervisor = createSidecarSupervisor({
      buildOpts: async () => ({}) as any,
      spawnFn: spawn.fn, nowFn: () => now, delayFn: async () => {}, log: vi.fn(), warn: vi.fn(),
    });
    await supervisor.start();
    for (let i = 0; i < 3; i++) { now += 35_000; spawn.exit(1); await Promise.resolve(); }
    expect(supervisor.tripEvent()).toBeNull();
  });

  it('a tripped supervisor stops respawning (holds TTS down)', async () => {
    let now = 0;
    const spawn = makeSpawn();
    const respawnCount = () => spawn.fn.mock.calls.length;
    const supervisor = createSidecarSupervisor({
      buildOpts: async () => ({}) as any,
      spawnFn: spawn.fn, nowFn: () => now, delayFn: async () => {}, log: vi.fn(), warn: vi.fn(),
    });
    await supervisor.start();
    const before = respawnCount();
    for (let i = 0; i < 3; i++) { now += 35_000; spawn.exit(43); await Promise.resolve(); }
    const afterTrip = respawnCount();
    now += 35_000;
    spawn.exit(43); // a 4th exit after trip must NOT trigger another respawn attempt
    await Promise.resolve();
    expect(respawnCount()).toBe(afterTrip);
    expect(afterTrip).toBeGreaterThan(before); // sanity: it DID respawn for exits 1-3, just not after trip
  });
});
```
Add `import * as breadcrumbModule from './restart-breadcrumb.js';` and `vi.mock('./restart-breadcrumb.js')` near the top of the test file (or use `vi.spyOn` on the real module if the file already imports it directly — match whichever mocking convention the rest of this test file already uses).

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && npx vitest run src/tts/sidecar-supervisor.test.ts -t "code-43 streak"`
Expected: FAIL — `supervisor.tripEvent` is not a function.

- [ ] **Step 4: Implement the streak counter + trip gate**

In `sidecar-supervisor.ts`, add near the other constants (~40-47):
```ts
const RESTART43_STREAK_WINDOW_MS = 600_000; // 10 min
const RESTART43_STREAK_TRIP_COUNT = 3;
```
Add the import at the top:
```ts
import { readRestartBreadcrumb } from './restart-breadcrumb.js';
```
Inside `createSidecarSupervisor` (~119), add new closure state next to `consecutiveFailures`/`lastSpawnAt` (~139-140):
```ts
  let restart43Timestamps: number[] = [];
  let restart43Trip: { card: unknown; residentEngines: string[] } | null = null;
```
At the TOP of `onChildExit` (258), before the existing `handle = null;` line, add the streak check and an early return on trip:
```ts
  function onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (stopped) return;
    if (code === 43) {
      const now = nowFn();
      restart43Timestamps = restart43Timestamps.filter((t) => now - t <= RESTART43_STREAK_WINDOW_MS);
      restart43Timestamps.push(now);
      if (restart43Timestamps.length >= RESTART43_STREAK_TRIP_COUNT && restart43Trip === null) {
        const breadcrumb = readRestartBreadcrumb();
        restart43Trip = { card: breadcrumb?.card ?? null, residentEngines: breadcrumb?.residentEngines ?? [] };
        handle = null;
        isRecycling = true;
        warn(
          `[sidecar] supervisor: ${restart43Timestamps.length} code-43 self-exits in ` +
            `${RESTART43_STREAK_WINDOW_MS / 60_000} minutes (card=${JSON.stringify(restart43Trip.card)}) — ` +
            `this device assignment looks structurally too small. Holding TTS down (no further ` +
            `respawn attempts) until the assignment changes and the server restarts.`,
        );
        return; // hold TTS down — no respawn.
      }
    }
    handle = null;
    isRecycling = true;
    const lived = nowFn() - lastSpawnAt;
    // ... rest of the existing function body, UNCHANGED from here down ...
```
**`clearTripAndRespawn()` — the missing recovery primitive (a round-3 adversarial review finding).** `tripEvent()` alone only lets a caller READ the trip; nothing in the original draft let anything CLEAR it and bring a sidecar back. Confirmed the gap is real by reading the EXISTING `POST /api/sidecar/restart` route (`server/src/routes/sidecar-health.ts:425-468`, untouched by this plan): it kills `supervisor.current()` and relies on `onChildExit` to respawn — but once tripped, `handle` is already `null` (the process self-exited) and the trip branch returns before ever reaching the normal respawn path, so that EXISTING manual-restart route ALSO 409s ("No sidecar child is currently running") on a tripped supervisor. There was no way back from a trip at all, automatic or manual, before this fix:
```ts
  function clearTripAndRespawn(): Promise<void> {
    restart43Trip = null;
    restart43Timestamps = [];
    return spawnOnce();
  }
```
Add `tripEvent()` AND `clearTripAndRespawn()` to the returned object (289-307):
```ts
  return {
    async start() { /* unchanged */ },
    async stop() { /* unchanged */ },
    current() { return handle; },
    recycling() { return isRecycling; },
    tripEvent() {
      return restart43Trip;
    },
    clearTripAndRespawn,
  };
```
And to the `SidecarSupervisor` interface (85-100):
```ts
  /** Non-null once 3+ code-43 self-exits happened within RESTART43_STREAK_
      WINDOW_MS — the assignment looks structurally too small. The supervisor
      stops respawning once this trips (TTS held down); Plan 2's auto-revert
      route (Task 16) reads this to rewrite the offending knob, then calls
      clearTripAndRespawn() to actually bring TTS back. */
  tripEvent: () => { card: unknown; residentEngines: string[] } | null;
  /** Clear a tripped streak and spawn a fresh sidecar child. The ONLY way
      back from a trip — neither the existing POST /api/sidecar/restart route
      (it requires a currently-running child to kill; a tripped supervisor
      has none) nor a fresh code-43 exit (nothing is running to exit) can
      recover otherwise. Safe to call when not tripped (resets an empty
      streak, respawns as normal — matches an ordinary manual restart). */
  clearTripAndRespawn: () => Promise<void>;
```

- [ ] **Step 4.5: Append the failing recovery test**

Append to `sidecar-supervisor.test.ts`, inside or after the code-43 streak `describe` block from Step 4:
```ts
it('clearTripAndRespawn resets the streak and spawns a fresh child after a trip', async () => {
  let now = 0;
  const spawn = makeSpawn();
  const respawnCount = () => spawn.fn.mock.calls.length;
  vi.spyOn(breadcrumbModule, 'readRestartBreadcrumb').mockReturnValue({
    card: { uuid: 'GPU-1', idx: 1 }, reason: 'reserved VRAM', residentEngines: ['coqui'],
  });
  const supervisor = createSidecarSupervisor({
    buildOpts: async () => ({}) as any,
    spawnFn: spawn.fn, nowFn: () => now, delayFn: async () => {}, log: vi.fn(), warn: vi.fn(),
  });
  await supervisor.start();
  for (let i = 0; i < 3; i++) { now += 35_000; spawn.exit(43); await Promise.resolve(); }
  expect(supervisor.tripEvent()).not.toBeNull();
  const beforeRecovery = respawnCount();

  await supervisor.clearTripAndRespawn();

  expect(supervisor.tripEvent()).toBeNull(); // trip cleared
  expect(respawnCount()).toBeGreaterThan(beforeRecovery); // a fresh child was spawned
  // A subsequent code-43 streak can trip again (the timestamp window was reset, not left poisoned):
  for (let i = 0; i < 3; i++) { now += 35_000; spawn.exit(43); await Promise.resolve(); }
  expect(supervisor.tripEvent()).not.toBeNull();
});
```

Run: `cd server && npx vitest run src/tts/sidecar-supervisor.test.ts -t "clearTripAndRespawn"` → FAIL, then implement per the block above → PASS.

- [ ] **Step 5: Run green**

Run: `cd server && npx vitest run src/tts/sidecar-supervisor.test.ts src/tts/restart-breadcrumb.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/sidecar-supervisor.ts server/src/tts/restart-breadcrumb.ts server/src/tts/sidecar-supervisor.test.ts server/src/tts/restart-breadcrumb.test.ts
git commit -m "feat(server): code-43 streak guard — hold TTS down after 3 self-exits in 10 minutes"
```

---

### Task 8: Node guards over the global GPU pool — don't cross-charge, don't cross-evict (§W2.6)

**Files:**
- Create: `server/src/gpu/analyzer-device-state.ts` (cache mirroring `vram-state.ts`'s exact shape)
- Modify: `server/src/tts/engine-vram-cost.ts` (`costForEngine('analyzer')` consults the cache)
- Modify: `server/src/routes/analysis.ts` (the ONLY real `detectOllamaDevice()` call site — confirmed by `grep -rn "detectOllamaDevice()" server/src`, at ~line 2243 — wires `setLastKnownAnalyzerDevice(...)` after the existing call. **A round-2 adversarial review caught this file missing from the original draft's Files list AND its commit** — Step 2's generic "grep every call site" instruction was correct, but the actual file that instruction resolves to was never named or committed, so the whole cross-charge optimization would have shipped dead code with the cache permanently `'unknown'`)
- Create: `server/src/gpu/engine-device.ts` (`engineDeviceIsGpu(engine)` helper)
- Modify: `server/src/gpu/residency.ts` (`shouldEvictBeforeSidecarLoad` signature)
- Modify: `server/src/gpu/gpu-load.ts` (`withGpuLoad` threads `engineOnGpu` through)
- Modify: `server/src/tts/ensure-sidecar-loaded.ts` (has an `engine: TtsEngine` in scope — passes `engineDeviceIsGpu(engine)`)
- Modify: `server/src/tts/persona-gpu-plan.ts` (`resolvePersonaGpuPlan` — Qwen-specific, pass `engineDeviceIsGpu('qwen')`)
- Modify: `server/src/routes/qwen-voice.ts` (`designQwenVoiceForCharacter`'s `withGpuLoad` call, ~line 326 — a Qwen voice-design flow, confirmed by the `gpuSemaphore.acquire(costForEngine('qwen'))` immediately inside it; pass `engineDeviceIsGpu('qwen')`. **A round-1 adversarial review caught this call site missing from the original draft** — `grep -rn "withGpuLoad(" server/src` surfaces exactly TWO real (non-test) callers, `ensure-sidecar-loaded.ts:136` and this one; the original plan only wired the first)
- Modify (APPEND): `server/src/gpu/residency.test.ts`, `server/src/gpu/gpu-load.test.ts`, `server/src/tts/engine-vram-cost.test.ts`, `server/src/routes/qwen-voice.test.ts`, `server/src/routes/analysis.test.ts`
- Create: `server/src/gpu/engine-device.test.ts`, `server/src/gpu/analyzer-device-state.test.ts`

**Design note (read before writing):** Node can only ever know the analyzer's GPU/CPU placement (`detectOllamaDevice`, `ollama-health.ts:76`), never its card index — so "don't cross-charge/cross-evict when the configured card differs" degrades, for Node, to the one thing it CAN determine synchronously: whether the CALLING TTS engine's own configured device knob is CPU. If the TTS engine about to run isn't touching the GPU at all, it categorically cannot contend with the analyzer for GPU memory, so both guards should skip their normal (conservative, assume-contention) behaviour in that case. This is a coarse, deliberately conservative narrowing — not a per-card solution (Non-goals, Round 5 confirms deferred).

**Scope boundary (a round-2 review question, answered here rather than left implicit):** this task narrows `costForEngine('analyzer')` for a CPU-confirmed analyzer, but deliberately does NOT narrow `costForEngine('qwen'|'coqui'|'kokoro')` when THAT engine is itself CPU-pinned — e.g. a `tts.qwen.device=cpu` synth still pays Qwen's full semaphore weight. This matches the spec's own §W2.6 text literally ("drop the **analyzer's** whole-budget cost..." — it only ever discusses the analyzer's side of the charge, not the TTS engines'), and Round 5 confirms Node budgets stay coarse/global. Not a gap to close in this plan; noted so the Self-Review's "§W2.6 ✓" doesn't overstate scope.

- [ ] **Step 1: `engine-device.ts` — write the failing test, then implement**

`server/src/gpu/engine-device.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/resolver.js', () => ({ configValue: vi.fn() }));

import { engineDeviceIsGpu } from './engine-device.js';
import { configValue } from '../config/resolver.js';

describe('engineDeviceIsGpu', () => {
  beforeEach(() => vi.clearAllMocks());

  it('true for cuda / cuda:N', () => {
    (configValue as any).mockReturnValue('cuda:1');
    expect(engineDeviceIsGpu('qwen')).toBe(true);
  });

  it('true for auto (conservative — auto usually resolves to a GPU)', () => {
    (configValue as any).mockReturnValue('auto');
    expect(engineDeviceIsGpu('coqui')).toBe(true);
  });

  it('false for cpu / mps', () => {
    (configValue as any).mockReturnValue('cpu');
    expect(engineDeviceIsGpu('kokoro')).toBe(false);
    (configValue as any).mockReturnValue('mps');
    expect(engineDeviceIsGpu('kokoro')).toBe(false);
  });

  it('true (conservative) for an engine with no registered device knob', () => {
    expect(engineDeviceIsGpu('gemini')).toBe(true);
    expect(configValue).not.toHaveBeenCalled();
  });
});
```
Run: `cd server && npx vitest run src/gpu/engine-device.test.ts` → FAIL (module missing).

`server/src/gpu/engine-device.ts`:
```ts
/* Resolves whether a TTS engine's CONFIGURED device knob is GPU or CPU-family
   — used by the Wave 2 §W2.6 Node guards, which can only reason about whether
   the engine about to load/run touches the GPU at all (never which card). */

import { configValue } from '../config/resolver.js';

const ENGINE_DEVICE_KEY: Record<string, string> = {
  qwen: 'tts.qwen.device',
  coqui: 'tts.coqui.device',
  kokoro: 'tts.kokoro.device',
};

/** True when `engine`'s configured device knob resolves to a GPU family
    (cuda/cuda:N, or auto — which usually resolves to a GPU, so treated as
    GPU conservatively). False only for an explicit cpu/mps pin. An engine
    with no registered device knob (e.g. 'gemini', a cloud engine) defaults
    to true — the conservative "assume contention is possible" choice, so a
    new engine never silently defeats these guards. */
export function engineDeviceIsGpu(engine: string): boolean {
  const key = ENGINE_DEVICE_KEY[engine];
  if (!key) return true;
  const raw = (configValue<string>(key) ?? 'auto').trim().toLowerCase();
  return raw === 'auto' || raw.startsWith('cuda');
}
```
Run: `cd server && npx vitest run src/gpu/engine-device.test.ts` → PASS.

- [ ] **Step 2: `analyzer-device-state.ts` — write the failing test, then implement**

`server/src/gpu/analyzer-device-state.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setLastKnownAnalyzerDevice, getLastKnownAnalyzerDevice } from './analyzer-device-state.js';

describe('analyzer-device-state', () => {
  beforeEach(() => setLastKnownAnalyzerDevice('unknown'));

  it('defaults to unknown', () => {
    expect(getLastKnownAnalyzerDevice()).toBe('unknown');
  });

  it('remembers the last set value', () => {
    setLastKnownAnalyzerDevice('cuda');
    expect(getLastKnownAnalyzerDevice()).toBe('cuda');
    setLastKnownAnalyzerDevice('cpu');
    expect(getLastKnownAnalyzerDevice()).toBe('cpu');
  });
});
```
`server/src/gpu/analyzer-device-state.ts`:
```ts
/* Last-known analyzer (Ollama) GPU/CPU placement, mirroring vram-state.ts's
   cache shape. Populated wherever detectOllamaDevice() already runs (it's
   async; this sync cache is what the W2.6 cost/eviction guards read). */

export type AnalyzerDevice = 'cuda' | 'cpu' | 'unknown';

let lastKnownAnalyzerDevice: AnalyzerDevice = 'unknown';

export function setLastKnownAnalyzerDevice(device: AnalyzerDevice): void {
  lastKnownAnalyzerDevice = device;
}

export function getLastKnownAnalyzerDevice(): AnalyzerDevice {
  return lastKnownAnalyzerDevice;
}
```
Run: `cd server && npx vitest run src/gpu/analyzer-device-state.test.ts` → PASS.

Wire the cache: `grep -rn "detectOllamaDevice()" server/src` confirms exactly ONE real (non-test) call site, `server/src/routes/analysis.ts` (~line 2241-2244). **Read the exact shape before writing the edit — a round-3 adversarial review found the call is NOT a bare statement you can append after; it's the RHS of a conditional assigned to a `const`:**
```ts
const analyzerDevice: 'cuda' | 'cpu' | 'unknown' =
  selection.engine === 'local' || phase1Selection.engine === 'local'
    ? await detectOllamaDevice()
    : 'unknown';
```
A literal "append after the call" edit would need a second, unconditional `await detectOllamaDevice()` — which both double-probes Ollama needlessly AND pollutes the cache with a live GPU/CPU reading even when the analysis actually ran on a CLOUD engine (where `analyzerDevice` is correctly `'unknown'`). **The correct edit uses the already-resolved variable, not a second probe:**
```ts
const analyzerDevice: 'cuda' | 'cpu' | 'unknown' =
  selection.engine === 'local' || phase1Selection.engine === 'local'
    ? await detectOllamaDevice()
    : 'unknown';
setLastKnownAnalyzerDevice(analyzerDevice);
```
Append a failing test to `analysis.test.ts` asserting `setLastKnownAnalyzerDevice` is called with `analyzerDevice`'s CONDITIONAL value — include a case where the engine is a cloud engine (e.g. `gemini`) and assert `setLastKnownAnalyzerDevice` is called with `'unknown'` **without** `detectOllamaDevice` having been called at all (not "called with whatever `detectOllamaDevice()` returns" — that phrasing describes the wrong, unconditional edit). **This file/site is easy to omit from the Files list and commit if you're skimming — it was missed in an earlier draft of this plan; double-check `server/src/routes/analysis.ts` is in your `git add` before Step 8.**

- [ ] **Step 3: `costForEngine('analyzer')` consults the cache — append the failing test, then implement**

Append to `server/src/tts/engine-vram-cost.test.ts`:
```ts
describe('costForEngine — analyzer cross-charge guard (W2.6)', () => {
  it('returns 0 when the analyzer is confirmed on CPU (no GPU contention possible)', () => {
    setLastKnownAnalyzerDevice('cpu');
    expect(costForEngine('analyzer')).toBe(0);
  });

  it('returns the configured weight when the analyzer is confirmed on GPU', () => {
    setLastKnownAnalyzerDevice('cuda');
    expect(costForEngine('analyzer')).toBe(configValue<number>('gpu.weight.analyzer'));
  });

  it('returns the configured weight when the analyzer placement is unknown (conservative)', () => {
    setLastKnownAnalyzerDevice('unknown');
    expect(costForEngine('analyzer')).toBe(configValue<number>('gpu.weight.analyzer'));
  });
});
```
Add the import at the top: `import { setLastKnownAnalyzerDevice } from '../gpu/analyzer-device-state.js';`

Run: `cd server && npx vitest run src/tts/engine-vram-cost.test.ts -t "cross-charge"` → FAIL.

In `engine-vram-cost.ts`, change the `'analyzer'` case:
```ts
import { getLastKnownAnalyzerDevice } from '../gpu/analyzer-device-state.js';

export function costForEngine(engine: string): number {
  switch (engine) {
    // ... kokoro/qwen/coqui cases unchanged ...
    case 'analyzer':
      // W2.6 "don't cross-charge": a CONFIRMED-cpu analyzer can't contend for
      // GPU memory at all, so it shouldn't consume semaphore budget. An
      // UNKNOWN placement stays charged (conservative — matches residency.ts's
      // "unknown → assume GPU" convention).
      return getLastKnownAnalyzerDevice() === 'cpu' ? 0 : configValue<number>('gpu.weight.analyzer');
    // ... asr/spk/gemini/default cases unchanged ...
  }
}
```
Update the file's header comment (lines 36-40, "For the six engines with registered gpu.weight.* knobs the value is read live through the registry") to note the analyzer's new CPU-placement exception in one added sentence — don't rewrite the whole comment.

Run: `cd server && npx vitest run src/tts/engine-vram-cost.test.ts` → PASS.

- [ ] **Step 4: `shouldEvictBeforeSidecarLoad` — don't cross-evict — append the failing test, then implement**

Append to `server/src/gpu/residency.test.ts`:
```ts
describe('shouldEvictBeforeSidecarLoad — engineOnGpu guard (W2.6)', () => {
  it('never evicts when the engine about to load is not itself on the GPU', () => {
    (configValue as any).mockReturnValue(11000);
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 8000 }, false)).toBe(false);
  });

  it('preserves existing behaviour when engineOnGpu defaults true', () => {
    (configValue as any).mockReturnValue(11000);
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 8000 })).toBe(true);
  });
});
```
Run: `cd server && npx vitest run src/gpu/residency.test.ts -t "engineOnGpu"` → FAIL.

`residency.ts`:
```ts
export function shouldEvictBeforeSidecarLoad(v: VramState, engineOnGpu: boolean = true): boolean {
  if (!engineOnGpu) return false; // this engine isn't touching the GPU — nothing to evict for.
  if (v.accelerator === 'cpu') return false;
  if (v.totalMb == null) return true;
  return v.totalMb < configValue<number>('gpu.safeCoexistMb');
}
```
Run: `cd server && npx vitest run src/gpu/residency.test.ts` → PASS (existing tests keep passing via the default param).

- [ ] **Step 5: Thread `engineOnGpu` through `withGpuLoad` + BOTH of its real callers**

Append to `server/src/gpu/gpu-load.test.ts`:
```ts
describe('withGpuLoad — engineOnGpu passthrough (W2.6)', () => {
  it('runs the load directly (no eviction check) when engineOnGpu is false, even on a constrained card', async () => {
    mockShouldEvict.mockReturnValue(true); // would normally require eviction
    const out = await withGpuLoad(async () => 'ok', false);
    expect(out).toBe('ok');
    expect(mockShouldEvict).not.toHaveBeenCalled();
  });
});
```
(Read the existing `vi.hoisted`/`vi.mock` block at the top of `gpu-load.test.ts` first — `mockShouldEvict` here stands in for whatever the file already names its mocked `shouldEvictBeforeSidecarLoad`; match the real name.)

`gpu-load.ts`:
```ts
export async function withGpuLoad<T>(loadFn: () => Promise<T>, engineOnGpu = true): Promise<T> {
  if (!engineOnGpu || !shouldEvictBeforeSidecarLoad(getLastKnownVram(), engineOnGpu)) {
    return loadFn();
  }
  return withGpuLoadLock(async () => {
    // ... unchanged body ...
  });
}
```
(The `!engineOnGpu ||` short-circuit is NOT merely stylistic — a round-3 adversarial review caught the original "redundant, costs nothing" framing as wrong: it's what makes the paired test's `expect(mockShouldEvict).not.toHaveBeenCalled()` assertion (Step 5's test above) actually pass, by short-circuiting BEFORE `shouldEvictBeforeSidecarLoad` is ever called. Keep it for that reason, not just readability.)

`ensure-sidecar-loaded.ts` (~126, `const { withGpuLoad } = await import(...)`) and the call at ~136:
```ts
  const { withGpuLoad } = await import('../gpu/gpu-load.js');
  const { engineDeviceIsGpu } = await import('../gpu/engine-device.js');
  // ...
  await withGpuLoad(async () => { /* unchanged body */ }, engineDeviceIsGpu(engine));
```

`persona-gpu-plan.ts` (~60, `resolvePersonaGpuPlan`) — this function calls `shouldEvictBeforeSidecarLoad` directly (not through `withGpuLoad`), for the Qwen-specific persona-generation reverse-evict decision:
```ts
import { engineDeviceIsGpu } from '../gpu/engine-device.js';

export function resolvePersonaGpuPlan(bookDir: string): PersonaGpuPlan {
  const constrained = shouldEvictBeforeSidecarLoad(getLastKnownVram(), engineDeviceIsGpu('qwen'));
  // ... rest unchanged ...
```

`routes/qwen-voice.ts` (~324-327, `designQwenVoiceForCharacter`) — **check the existing `withGpuLoad` mock in `qwen-voice.test.ts` (~line 67 at review time) before writing the new test.** A round-2 adversarial review found it currently forwards only the first argument (`withGpuLoad: (fn) => withGpuLoadMock(fn)`), which silently swallows a second argument — so a naive new assertion on "was `engineDeviceIsGpu('qwen')` passed" would pass trivially without checking anything. Widen the mock to `withGpuLoad: (fn, onGpu) => withGpuLoadMock(fn, onGpu)` FIRST (a small, isolated change — confirm no other test in the file already depends on the mock's exact arity), THEN append the new failing test asserting `withGpuLoadMock.mock.calls[0][1]` is `true` for a GPU-configured Qwen knob, then wire the real call:
```ts
  return withDesignLock(p.bookDir, async () => {
    const { withGpuLoad } = await import('../gpu/gpu-load.js');
    const { engineDeviceIsGpu } = await import('../gpu/engine-device.js');
    return withGpuLoad(async () => {
      // ... unchanged body ...
    }, engineDeviceIsGpu('qwen'));
  });
```

- [ ] **Step 6: Run everything green**

Run: `cd server && npx vitest run src/gpu/engine-device.test.ts src/gpu/analyzer-device-state.test.ts src/gpu/residency.test.ts src/gpu/gpu-load.test.ts src/tts/engine-vram-cost.test.ts src/routes/qwen-voice.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full server suite to catch any other `shouldEvictBeforeSidecarLoad`/`withGpuLoad` call site this task missed**

Run: `cd server && npm run test`
Expected: PASS. If a test fails on an unexpected-argument-count basis, grep `shouldEvictBeforeSidecarLoad(` and `withGpuLoad(` across `server/src` one more time — the research pass found exactly these call sites, but re-verify before concluding this step is done.

- [ ] **Step 8: Commit**

```bash
git add server/src/gpu/analyzer-device-state.ts server/src/gpu/analyzer-device-state.test.ts server/src/gpu/engine-device.ts server/src/gpu/engine-device.test.ts server/src/gpu/residency.ts server/src/gpu/residency.test.ts server/src/gpu/gpu-load.ts server/src/gpu/gpu-load.test.ts server/src/tts/engine-vram-cost.ts server/src/tts/engine-vram-cost.test.ts server/src/tts/ensure-sidecar-loaded.ts server/src/tts/persona-gpu-plan.ts server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts server/src/routes/analysis.ts server/src/routes/analysis.test.ts
git commit -m "feat(server): Node guards — don't cross-charge/cross-evict a GPU-idle engine (W2.6)"
```

---

### Task 9: Wave 2 on-box acceptance checklist

**Files:**
- Modify: this plan file (append a Ship-notes section, mirroring Wave 1's own plan doc pattern)

- [ ] **Step 1: Run the full sidecar + server suites one more time**

Run: `cd server/tts-sidecar && ..\..\server\tts-sidecar\.venv\Scripts\python.exe -m pytest -v` (or `npm run test:sidecar` from repo root) and `cd server && npm run test`.
Expected: PASS.

- [ ] **Step 2: Append the on-box checklist**

Add to this file's Ship-notes section (see the bottom of this document — filled in once Wave 2 merges):
```markdown
- [ ] **First, confirm torch exposes real per-card UUIDs on this box**: `python -c "import torch; print(torch.cuda.get_device_properties(0).uuid)"` in the sidecar venv → prints a real UUID, not an `AttributeError`. If it errors, `_sample_card`'s `idx-N` synthetic fallback is in effect and `DeviceLedger`'s renumber-detection (Task 1) is a no-op on this box — note this explicitly in the Ship notes rather than silently assuming the guarantee holds (a round-2 review finding).
- [ ] `SIDECAR_VRAM_FREE_FLOOR_MB=1024` (default) — starve a card to <1024MB free (load something else onto it manually / reduce via a smaller test card) → sidecar self-exits (code 43), `/health` gpus[] showed the breach before exit.
- [ ] `QWEN_DEVICE=cuda:0 KOKORO_DEVICE=cuda:1` (different cards) → a VoiceDesign session runs WHILE a Kokoro chapter synthesizes concurrently, no blocking (shares_device=False path).
- [ ] `QWEN_DEVICE=cuda:0 KOKORO_DEVICE=cuda:0` (same card, default) → VoiceDesign blocks new Kokoro synths until it completes (shares_device=True path, unchanged from Wave 1).
- [ ] Force 3 code-43 exits within 10 minutes via a CARD-SPECIFIC trigger (e.g. temporarily set `SIDECAR_VRAM_FREE_FLOOR_MB` absurdly high) → server log shows the streak-trip warning; the sidecar stops respawning; `supervisor.tripEvent()` shows the right card + resident engines.
- [ ] **Force 3 code-43 exits within 10 minutes via a NON-card-specific trigger** (e.g. temporarily set `SIDECAR_RESTART_MB` absurdly low so the HOST-RAM ceiling trips 3× in a row) → the streak still trips (Task 7 counts any code-43, not just per-card ones); Task 16's `runAutoRevert` logs the distinct "tripped WITHOUT a specific card... requires MANUAL investigation" error rather than silently returning `{reverted:[]}`; TTS stays held down as expected, but this is now VISIBLE (Task 16.5's `/api/gpu/trip-status` reports `status:'unrevertable'`).
- [ ] Analyzer confirmed on CPU (`ANALYZER=local` with an Ollama CPU-only install) — **run at least one analysis first** (the cache in `analyzer-device-state.ts` is only populated at the one real `detectOllamaDevice()` call site, `routes/analysis.ts`; it stays `'unknown'`/full-charge before that, by design — a round-2 review caught this checklist item as untested-until-populated) → a concurrent Qwen GPU synth is NOT serialized behind the analyzer (costForEngine('analyzer') returns 0).
- [ ] Analyzer confirmed on GPU → existing serialization behaviour is UNCHANGED (regression check against pre-Wave-2 behaviour).
- [ ] `COQUI_DEVICE=cpu` while the analyzer holds the GPU → the Coqui load runs immediately, no eviction wait (engineOnGpu=false path in withGpuLoad).
- [ ] Qwen voice-design (`routes/qwen-voice.ts`'s `designQwenVoiceForCharacter`) while `tts.qwen.device=cpu` → the design's `withGpuLoad` call runs immediately too (the second `withGpuLoad` call site Task 8 wires, not just `ensure-sidecar-loaded.ts`'s).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-02-multi-gpu-wave2-plan2.md
git commit -m "docs(docs): Wave 2 on-box acceptance checklist"
```

---

# PART B — Plan 2: Picker UI + Canonical UUID (extends the Advanced Configuration rows from #1205)

**Gated on Wave 2 landing and passing on-box acceptance** (Task 16's auto-revert directly consumes Task 7's `tripEvent()`).

### Task 10: Canonical GPU UUID identity (§2.1)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `_resolve_uuid_to_index`, `_read_device_env`; swap the ~5 `os.environ.get("*_DEVICE")` call sites for QWEN/COQUI/KOKORO to route through it)
- Modify: `server/src/routes/config.ts` (PUT handler — translate a `cuda:N` write into `cuda-uuid:<uuid>` for `type==='device'` knobs)
- Create: `server/src/routes/gpu-uuid.ts` (small helper: resolve `cuda:N` → uuid from the live device list, and the reverse on read)
- Modify: `server/src/config/resolver.ts` (`resolveKnob` reconciles a stored `cuda-uuid:<uuid>` back to a DISPLAY `cuda:N`, or flags it unresolved)
- Modify: `server/src/config/types.ts` (`KnobValueState.staleReason` — Step 9)
- Create: `server/src/gpu/gpu-device-list-state.ts` (last-known device list cache — Step 9)
- Modify: `server/src/routes/gpu-devices.ts` (populates the cache above on every successful proxy response — Step 9)
- Modify (APPEND): `server/tts-sidecar/tests/test_device_parse.py`, `server/src/routes/config.test.ts`, `server/src/config/resolver.test.ts`, `server/src/routes/gpu-devices.test.ts`

**Interfaces (consumed by Tasks 11-13):**
- `_resolve_uuid_to_index(value: Optional[str], torch_module: Any = None) -> Optional[str]` — a `'cuda-uuid:<uuid>'` value resolves to the CURRENT `'cuda:N'` via live enumeration; any other value passes through unchanged; returns `None` when the uuid matches no visible card (caller decides the fallback — never silently substitutes a different card).
- `_read_device_env(var_name: str) -> Optional[str]` — the wrapper every `*_DEVICE` env read should use going forward.
- `KnobValueState` gains `staleReason?: 'cpu_fallback' | 'env_shadow' | 'uuid_unresolved'` (Task 11 populates `cpu_fallback`/`env_shadow`; this task populates `uuid_unresolved`).

- [ ] **Step 1: Sidecar — write the failing tests**

Append to `test_device_parse.py`:
```python
def test_resolve_uuid_to_index_passthrough_for_non_uuid_values():
    assert main._resolve_uuid_to_index("cuda:1") == "cuda:1"
    assert main._resolve_uuid_to_index("auto") == "auto"
    assert main._resolve_uuid_to_index(None) is None
    assert main._resolve_uuid_to_index("cpu") == "cpu"


def test_resolve_uuid_to_index_resolves_a_known_uuid(monkeypatch):
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    assert main._resolve_uuid_to_index("cuda-uuid:GPU-1") == "cuda:1"


def test_resolve_uuid_to_index_none_for_unknown_uuid(monkeypatch):
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    assert main._resolve_uuid_to_index("cuda-uuid:GPU-VANISHED") is None


def test_read_device_env_resolves_uuid(monkeypatch):
    monkeypatch.setenv("QWEN_DEVICE", "cuda-uuid:GPU-1")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    assert main._read_device_env("QWEN_DEVICE") == "cuda:1"


def test_read_device_env_falls_back_to_auto_when_uuid_unresolved(monkeypatch, caplog):
    monkeypatch.setenv("QWEN_DEVICE", "cuda-uuid:GONE")
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    assert main._read_device_env("QWEN_DEVICE") == "auto"
```

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -k uuid -v`
Expected: FAIL — both functions undefined.

- [ ] **Step 3: Implement**

Near `_parse_device` (main.py ~1327):
```python
def _resolve_uuid_to_index(value: Optional[str], torch_module: Any = None) -> Optional[str]:
    """Front seam for Plan 2's UUID identity: a 'cuda-uuid:<uuid>' knob value
    resolves to the box's CURRENT 'cuda:N' index via live enumeration. Any
    other value (auto/cpu/mps/cuda:N/None) passes through unchanged. Returns
    None when the uuid matches no visible card — the caller decides the
    fallback; this function never silently substitutes a different card."""
    if not value or not value.startswith("cuda-uuid:"):
        return value
    target_uuid = value[len("cuda-uuid:"):]
    for card in _enumerate_cuda_devices(torch_module):
        if card["uuid"] == target_uuid:
            return f"cuda:{card['idx']}"
    return None


def _read_device_env(var_name: str) -> Optional[str]:
    """Read a *_DEVICE env var, resolving a Plan-2 UUID form to this box's
    current index. Every device-knob env read should go through this instead
    of a bare os.environ.get, so a UUID-keyed assignment (portable across a
    box's own restarts, robust to index renumbering) always resolves against
    the box's LIVE card list."""
    raw = os.environ.get(var_name)
    resolved = _resolve_uuid_to_index(raw)
    if raw and raw.startswith("cuda-uuid:") and resolved is None:
        log.warning("%s=%s did not match any visible GPU (uuid_unresolved) — falling back to auto.", var_name, raw)
        return "auto"
    return resolved
```

- [ ] **Step 4: Swap the QWEN/COQUI/KOKORO env-read call sites**

Run `grep -n 'os.environ.get("QWEN_DEVICE"\|os.environ.get("COQUI_DEVICE"\|os.environ.get("KOKORO_DEVICE"' server/tts-sidecar/main.py` to find every current call site (Task 5 of this plan already added one at the design-load path — update that one too, replacing the "Note" workaround left there with the real `_read_device_env` call now that it exists). Replace each `os.environ.get("QWEN_DEVICE", "auto")`-shaped call with `_read_device_env("QWEN_DEVICE") or "auto"` (same for COQUI/KOKORO). **Do not touch `SPK_DEVICE`/`ASR_DEVICE`** — those stay plain `string` knobs (never widened to `device` type, per #1205's explicit scope, so they never get a UUID form from the frontend).

- [ ] **Step 5: Run green**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -v` and the full sidecar suite: `.\.venv\Scripts\python.exe -m pytest -v`
Expected: PASS.

- [ ] **Step 6: Node — write the failing PUT-handler test**

Append to `server/src/routes/config.test.ts` (read its existing PUT-handler test setup first — it likely already mocks `getGpuDevices`/fetches to the sidecar via whatever the route test harness for `configRouter` uses):
```ts
describe('PUT /api/config — device knob UUID translation (Plan 2 §2.1)', () => {
  it('translates a cuda:N write into cuda-uuid:<uuid> before persisting', async () => {
    // Arrange the sidecar device list the same way this file's other device-knob
    // tests already mock it (read them first for the exact mock target/shape).
    mockGpuDevices([{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }]);
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'cuda:1' });
    expect(res.status).toBe(200);
    expect(writeConfigOverrideMock).toHaveBeenCalledWith('tts.qwen.device', 'cuda-uuid:GPU-1');
  });

  it('stores the raw cuda:N when the sidecar device list has no match yet (reconciled on next read)', async () => {
    mockGpuDevices([]);
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'cuda:9' });
    expect(res.status).toBe(200);
    expect(writeConfigOverrideMock).toHaveBeenCalledWith('tts.qwen.device', 'cuda:9');
  });

  it('leaves auto/cpu/mps values untouched', async () => {
    const res = await request(app).put('/api/config').send({ 'tts.qwen.device': 'auto' });
    expect(res.status).toBe(200);
    expect(writeConfigOverrideMock).toHaveBeenCalledWith('tts.qwen.device', 'auto');
  });
});
```
> `mockGpuDevices`/`writeConfigOverrideMock`/`request(app)` are placeholders for whatever this test file's ACTUAL existing helpers are named — `grep -n "describe(" server/src/routes/config.test.ts` and match the established names before writing this block; do not invent new mock plumbing if the file already has it.

- [ ] **Step 7: Run to verify it fails, then implement**

Run: `cd server && npx vitest run src/routes/config.test.ts -t "UUID translation"` → FAIL.

`server/src/routes/gpu-uuid.ts`:
```ts
/* Plan 2 §2.1 — translate between a frontend-facing 'cuda:N' device-knob
   value and the canonical 'cuda-uuid:<uuid>' form persisted to disk, so a
   stored assignment survives index renumbering across a box's restarts. */

import { getGpuDevices } from '../tts/gpu-devices-client.js'; // or wherever this route's Node-side GPU-list fetch already lives — verify the real import path against gpu-devices.ts's existing consumers before writing.

/** 'cuda:N' -> 'cuda-uuid:<uuid>' using the CURRENT live device list. Returns
    the input unchanged if it isn't a bare 'cuda:N' form, or if no card at
    that index is currently visible (stored as-is; reconciled on next read). */
export async function toUuidForm(value: string): Promise<string> {
  const m = /^cuda:(\d+)$/.exec(value);
  if (!m) return value;
  const idx = Number(m[1]);
  const devices = await getGpuDevices();
  const card = devices.find((d) => d.idx === idx);
  return card ? `cuda-uuid:${card.uuid}` : value;
}
```
> Verify the real Node-side function that already calls the sidecar's `/devices` (the `gpu-devices.ts` proxy route is an HTTP endpoint, not directly importable — find whatever internal helper `routes/gpu-devices.ts` itself calls to fetch the sidecar's device list, or fetch `GET /devices` from the sidecar directly here via `getResolvedSidecarUrl()`, mirroring `gpu-devices.ts`'s own fetch pattern, since a route handler calling another route handler in-process is not this codebase's convention).

In `routes/config.ts`'s PUT handler (42-66), after `const r = coerceAndValidate(knob, raw);` and before `await writeConfigOverride(key, r.value!);`:
```ts
    if (knob.type === 'device' && typeof r.value === 'string') {
      r.value = await toUuidForm(r.value);
    }
```
Add the import: `import { toUuidForm } from './gpu-uuid.js';`

- [ ] **Step 8: Run green**

Run: `cd server && npx vitest run src/routes/config.test.ts`
Expected: PASS.

- [ ] **Step 9: Reconcile on read — `resolveKnob` translates a stored UUID back for display**

Append to `server/src/config/resolver.test.ts`:
```ts
describe('resolveKnob — device UUID reconcile (Plan 2 §2.1)', () => {
  it('translates a stored cuda-uuid override back to cuda:N when the card is currently visible', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GPU-1' });
    mockGpuDeviceList([{ uuid: 'GPU-1', idx: 1 }]); // match this file's existing mocking convention
    const st = resolveKnob(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda:1');
    expect(st.staleReason).toBeUndefined();
  });

  it('flags uuid_unresolved when the stored uuid matches no currently-visible card', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GONE' });
    mockGpuDeviceList([]);
    const st = resolveKnob(getKnob('tts.qwen.device')!);
    expect(st.staleReason).toBe('uuid_unresolved');
  });
});
```
This requires `resolveKnob` to become able to look up the live device list, which today is fetched async from the sidecar (`getGpuDevices`) — but `resolveKnob` is a SYNCHRONOUS function called throughout the codebase (`resolveAll`, `configValue`, etc.). **Do not make `resolveKnob` async** (that would ripple through dozens of call sites). Instead, reconcile against the SAME last-known-device-list cache pattern already established for VRAM (`vram-state.ts`) — add a small `gpu-device-list-state.ts` cache (`setLastKnownGpuDevices`/`getLastKnownGpuDevices`), populated wherever `getGpuDevices()` already resolves server-side (the `gpu-devices.ts` proxy route handler, right before it returns), and have `resolveKnob` consult that SYNCHRONOUS cache — accepting that the reconcile is only as fresh as the last successful `/api/gpu/devices` poll (matching how `vram-state.ts`'s `lastKnownVram` already accepts staleness for the SAME reason).

`server/src/gpu/gpu-device-list-state.ts` (new, mirrors `vram-state.ts` exactly):
```ts
export interface GpuDeviceInfo { uuid: string; idx: number }

let lastKnownGpuDevices: GpuDeviceInfo[] = [];

export function setLastKnownGpuDevices(devices: GpuDeviceInfo[]): void {
  lastKnownGpuDevices = devices;
}

export function getLastKnownGpuDevices(): GpuDeviceInfo[] {
  return lastKnownGpuDevices;
}
```
Wire it into `routes/gpu-devices.ts`'s success path (the `return res.json(body);` line) — add `setLastKnownGpuDevices(body.devices ?? []);` immediately before returning.

In `resolver.ts`, extend `resolveKnob` (the `override` branch, line 33):
```ts
  const overrides = readConfigOverrides();
  if (Object.prototype.hasOwnProperty.call(overrides, knob.key)) {
    const raw = overrides[knob.key];
    if (knob.type === 'device' && typeof raw === 'string' && raw.startsWith('cuda-uuid:')) {
      const uuid = raw.slice('cuda-uuid:'.length);
      const card = getLastKnownGpuDevices().find((d) => d.uuid === uuid);
      if (card) {
        return { key: knob.key, effective: `cuda:${card.idx}`, source: 'override', locked: false, overridden: true };
      }
      return { key: knob.key, effective: raw, source: 'override', locked: false, overridden: true, staleReason: 'uuid_unresolved' };
    }
    return { key: knob.key, effective: raw, source: 'override', locked: false, overridden: true };
  }
```
Add `staleReason?: 'cpu_fallback' | 'env_shadow' | 'uuid_unresolved';` to `KnobValueState` in `types.ts` (Task 11 populates the other two reasons).

- [ ] **Step 10: Run green**

Run: `cd server && npx vitest run src/config/resolver.test.ts src/routes/config.test.ts src/routes/gpu-devices.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_parse.py server/src/routes/config.ts server/src/routes/gpu-uuid.ts server/src/config/resolver.ts server/src/config/types.ts server/src/gpu/gpu-device-list-state.ts server/src/routes/gpu-devices.ts server/src/routes/config.test.ts server/src/config/resolver.test.ts
git commit -m "feat(sidecar,server): canonical GPU-UUID device identity (Plan 2 §2.1)"
```

---

### Task 10.5: Route Wave 2's raw device-env reads through the UUID resolver (closes an adversarial-review finding)

**Why this task exists:** an adversarial review of this plan (assumption-checker pass, 2026-07-02) traced a concrete bug: Task 4's `_compute_vd_kokoro_shares_device()` and Task 5's `_qwen_configured_card_idx()` both read `os.environ.get("QWEN_DEVICE"/"KOKORO_DEVICE")` **directly**, bypassing Task 10's `_read_device_env()`. Once an operator sets a UUID-keyed override (Task 10 makes this the NORMAL path for any `cuda:N` picker selection), `_parse_device("cuda-uuid:GPU-1")` misparses it: `"cuda-uuid:GPU-1".startswith("cuda")` is `True`, so it falls into the cuda branch; `"cuda-uuid:GPU-1".partition(":")` yields `("cuda-uuid", ":", "GPU-1")`, so the index fragment is `"GPU-1"` — not a digit — so `_parse_device` returns `("cuda", None)`. Both `shares_device()` and `_qwen_configured_card_idx()` then default the index to **card 0** (`idx_a or 0` / `idx or 0`) regardless of which card is actually configured. Concretely: `shares_device` can report the wrong coupling verdict, and **Task 5's per-card mutex silently always locks card 0**, providing zero protection for a UUID-pinned engine on any other card — undermining the entire point of Wave 2's per-card safety net the moment Plan 2's picker is used for a multi-GPU assignment.

This task must land **after Task 10** (needs `_read_device_env` to exist) but the fix belongs conceptually to Wave 2's safety guarantees — hence the `10.5` numbering, keeping it adjacent to the UUID work it depends on rather than shipping Wave 2 with a known-reintroduced gap once Plan 2 lands.

**Files:**
- Modify: `server/tts-sidecar/main.py` (`_compute_vd_kokoro_shares_device`, `_qwen_configured_card_idx` — swap raw `os.environ.get` for `_read_device_env`)
- Modify (APPEND): `server/tts-sidecar/tests/test_design_kokoro_exclusion.py`, `server/tts-sidecar/tests/test_device_ledger.py`

**Interfaces:** no new interfaces — closes a call-site gap in two functions Tasks 4 and 5 already defined; their signatures are unchanged.

- [ ] **Step 1: Write the failing regression tests**

Append to `test_design_kokoro_exclusion.py`:
```python
def test_compute_vd_kokoro_shares_device_routes_through_read_device_env(monkeypatch):
    """Regression for the adversarial-review finding: the coupling computation
    must resolve a UUID override BEFORE handing it to shares_device, not read
    raw env directly (a cuda-uuid:<uuid> value would otherwise misparse as
    unindexed 'cuda' in _parse_device and silently default to card 0)."""
    calls = []

    def fake_read(var_name):
        calls.append(var_name)
        return {"QWEN_DEVICE": "cuda:0", "KOKORO_DEVICE": "cuda:1"}[var_name]

    monkeypatch.setattr(main, "_read_device_env", fake_read)
    monkeypatch.setattr(main, "shares_device", lambda a, b, tm=None: (a, b) == ("cuda:0", "cuda:1"))
    result = main._compute_vd_kokoro_shares_device()
    assert set(calls) == {"QWEN_DEVICE", "KOKORO_DEVICE"}
    assert result is True  # shares_device was called with the RESOLVED values, matching the fake's condition


def test_compute_vd_kokoro_shares_device_uuid_override_resolves_to_correct_card(monkeypatch):
    """End-to-end proof the original bug is fixed: a cuda-uuid: override for
    QWEN_DEVICE resolves to the SAME concrete card _resolve_torch_device would
    report for the plain cuda:N form — not silently 'card 0' by default."""
    monkeypatch.setenv("QWEN_DEVICE", "cuda-uuid:GPU-1")  # resolves to cuda:1, NOT cuda:0
    monkeypatch.setenv("KOKORO_DEVICE", "cuda:1")  # same card -> should COUPLE
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [
        {"uuid": "GPU-0", "idx": 0, "name": "a", "total_mb": 8000, "free_mb": 6000},
        {"uuid": "GPU-1", "idx": 1, "name": "b", "total_mb": 16000, "free_mb": 14000},
    ])
    seen = {}

    def spy_shares_device(a, b, tm=None):
        seen["a"], seen["b"] = a, b
        return a == b
    monkeypatch.setattr(main, "shares_device", spy_shares_device)
    assert main._compute_vd_kokoro_shares_device() is True
    assert seen == {"a": "cuda:1", "b": "cuda:1"}  # NOT {"a": "cuda:0", ...} — the pre-fix bug's symptom
```

Append to `test_device_ledger.py`:
```python
def test_qwen_configured_card_idx_resolves_uuid_override(monkeypatch):
    monkeypatch.setenv("QWEN_DEVICE", "cuda-uuid:GPU-1")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    assert main._qwen_configured_card_idx() == 1  # NOT 0 — the pre-fix bug's symptom


def test_qwen_configured_card_idx_defaults_to_0_for_plain_auto(monkeypatch):
    monkeypatch.setenv("QWEN_DEVICE", "auto")
    assert main._qwen_configured_card_idx() == 0
```

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_design_kokoro_exclusion.py -k "routes_through_read_device_env or uuid_override_resolves" tests/test_device_ledger.py -k "qwen_configured_card_idx" -v`
Expected: FAIL — `test_compute_vd_kokoro_shares_device_routes_through_read_device_env` fails because `_compute_vd_kokoro_shares_device` still calls `os.environ.get` directly, never touching the mocked `_read_device_env` (`calls` stays empty); `test_qwen_configured_card_idx_resolves_uuid_override` fails because `_qwen_configured_card_idx` returns `0` (the misparse bug) instead of `1`.

- [ ] **Step 3: Fix both functions**

`_compute_vd_kokoro_shares_device` (added in Task 4):
```python
def _compute_vd_kokoro_shares_device() -> bool:
    """Resolve whether QWEN_DEVICE and KOKORO_DEVICE currently share a card.
    Routes through _read_device_env (Task 10) so a UUID-keyed override
    resolves to its real current index BEFORE shares_device sees it — reading
    raw env here would misparse 'cuda-uuid:<uuid>' as unindexed 'cuda' in
    _parse_device (startswith('cuda') matches, the uuid fragment isn't a
    digit) and silently default both engines to card 0. Any failure defaults
    True — the SAFE, conservative choice (stay coupled)."""
    try:
        return shares_device(_read_device_env("QWEN_DEVICE"), _read_device_env("KOKORO_DEVICE"))
    except Exception:
        return True
```

`_qwen_configured_card_idx` (added in Task 5):
```python
def _qwen_configured_card_idx() -> int:
    """Best-effort resolved card index for QWEN_DEVICE, used to pick the
    per-card mutex the 1.7B-Base design-load path acquires (Task 5). Routes
    through _read_device_env (Task 10) for the same reason
    _compute_vd_kokoro_shares_device does — see its docstring."""
    fam, idx = _parse_device(_read_device_env("QWEN_DEVICE"))
    return idx or 0
```

- [ ] **Step 4: Run green**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_design_kokoro_exclusion.py tests/test_device_ledger.py tests/test_device_parse.py -v`
Expected: PASS — including Task 4's original tests (`test_compute_vd_kokoro_shares_device_reads_env`/`_defaults_true_on_error`, which mocked `shares_device` directly and are unaffected by this internal change) and Task 5's original `test_card_lock_serialises_two_threads_on_same_idx`.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_design_kokoro_exclusion.py server/tts-sidecar/tests/test_device_ledger.py
git commit -m "fix(sidecar): route shares_device/per-card-mutex device reads through the UUID resolver"
```

---

### Task 11: `lockedByEnv` + env-shadow detection for `CUDA_VISIBLE_DEVICES`/`CUDA_DEVICE_ORDER` (§2.5, config-read half)

**Files:**
- Modify: `server/src/config/types.ts` (`KnobValueState.lockedByEnv?: boolean`)
- Modify: `server/src/routes/config.ts` (`GET /` response — surface a top-level `cudaEnvShadow: boolean` when `CUDA_VISIBLE_DEVICES`/`CUDA_DEVICE_ORDER` are set in `process.env`, since the registry path can't see raw env vars that aren't knobs)
- Modify (APPEND): `server/src/routes/config.test.ts`

**Note:** `resolveKnob`'s `locked` field (resolver.ts:20) is ALREADY functionally "locked by env" today — every `locked:true` case IS an env lock. The spec's `lockedByEnv` distinction matters specifically for `CUDA_VISIBLE_DEVICES`/`CUDA_DEVICE_ORDER`, which are **raw env, not knobs at all** (no registry entry reads them), so the existing `locked` mechanism can't see them. This task adds a SEPARATE, small surfacing of just those two vars — it does not touch the existing per-knob `locked` semantics.

- [ ] **Step 1: Append the failing test**

```ts
describe('GET /api/config — CUDA env-shadow surfacing (Plan 2 §2.5)', () => {
  const prevCVD = process.env.CUDA_VISIBLE_DEVICES;
  const prevCDO = process.env.CUDA_DEVICE_ORDER;
  afterEach(() => {
    if (prevCVD === undefined) delete process.env.CUDA_VISIBLE_DEVICES; else process.env.CUDA_VISIBLE_DEVICES = prevCVD;
    if (prevCDO === undefined) delete process.env.CUDA_DEVICE_ORDER; else process.env.CUDA_DEVICE_ORDER = prevCDO;
  });

  it('reports cudaEnvShadow true when CUDA_VISIBLE_DEVICES is set', async () => {
    process.env.CUDA_VISIBLE_DEVICES = '1,0';
    delete process.env.CUDA_DEVICE_ORDER;
    const res = await request(app).get('/api/config');
    expect(res.body.cudaEnvShadow).toBe(true);
  });

  it('reports cudaEnvShadow false when neither var is set', async () => {
    delete process.env.CUDA_VISIBLE_DEVICES;
    delete process.env.CUDA_DEVICE_ORDER;
    const res = await request(app).get('/api/config');
    expect(res.body.cudaEnvShadow).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `cd server && npx vitest run src/routes/config.test.ts -t "env-shadow"` → FAIL.

In `configRouter.get('/', ...)` (23-40):
```ts
configRouter.get('/', (_req, res) => {
  const descriptors = allKnobs().map((k) => ({ /* unchanged */ }));
  res.json({
    groups: GROUPS,
    descriptors,
    values: resolveAll(),
    restartPending: false,
    cudaEnvShadow: Boolean(process.env.CUDA_VISIBLE_DEVICES || process.env.CUDA_DEVICE_ORDER),
  });
});
```

- [ ] **Step 3: Run green**

Run: `cd server && npx vitest run src/routes/config.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/config.ts server/src/routes/config.test.ts
git commit -m "feat(server): surface CUDA_VISIBLE_DEVICES/CUDA_DEVICE_ORDER env-shadow (Plan 2 §2.5)"
```

---

### Task 12: Frontend — resident-vs-assigned + `stale_reason` badge on the device rows (§2.2 badge half)

**Scope correction (2026-07-02, resolved during Plan 2a execution):** Task 10's
own forward-reference comments (`types.ts`/`resolver.ts`) said "Task 11
populates the per-knob `cpu_fallback`/`env_shadow` `staleReason`s" — but
Task 11 as actually written only adds a top-level `cudaEnvShadow: boolean`
(§2.5 config-read half), never a per-knob `staleReason:'env_shadow'`. This
was a genuine plan-authoring inconsistency, caught by Task 11's task-review
and resolved with the user: `env_shadow` is a GLOBAL fact (`CUDA_VISIBLE_
DEVICES` shadows every `cuda:N` pin identically, not one engine specifically)
— rendering it as three duplicate per-row badges would be worse UX than one
banner. **`StaleReason` therefore drops `'env_shadow'`, keeping only
`'cpu_fallback' | 'uuid_unresolved'`** (both genuinely per-engine facts). The
top-level `cudaEnvShadow` flag Task 11 already shipped is consumed by a new
Step 6 in Task 17 (§2.5's e2e/a11y task, the natural home for the rest of
the §2.5 cutover story) as a single Advanced Configuration banner.

**Files:**
- Modify: `src/lib/types.ts` (extend `GpuDevice`/add a `GpuResidentInfo` type mirroring the sidecar's `/health` `gpus[].resident[]`; `KnobValueState`/`KnobValue` gains `staleReason?`)
- Modify: `src/lib/api.ts` (extend `getGpuDevices` — or add a sibling call — to also surface resident/stale_reason data; simplest: extend the EXISTING `/api/gpu/devices` response to include it, see Task 13 below for the server-side plumbing this depends on)
- Modify: `src/components/settings/override-row.tsx` (the `type==='device'` branch renders a badge when `value.staleReason` is set)
- Modify (APPEND): `src/components/settings/override-row.test.tsx`

**a11y requirement (spec §2.2, verified against `src/test/a11y.test.tsx` — Advanced Configuration has NO existing a11y coverage, added in Task 17):** the two `stale_reason`s must be distinguishable WITHOUT relying on color alone — use distinct TEXT labels (not just colored dots), matching the existing `.env` pill's pattern (`override-row.tsx:172-174`, already text-based: `.env`).

- [ ] **Step 1: Extend the types**

`src/lib/types.ts` — find `GpuDevice`/`GpuDevicesResponse` (added by #1205) and `KnobValueState`/`KnobValue`, add:
```ts
export type StaleReason = 'cpu_fallback' | 'uuid_unresolved';

// Extend the existing KnobValue/KnobValueState interface (whichever the
// frontend actually names it post-#1205 — grep first) with:
//   staleReason?: StaleReason;
```
> Read the CURRENT `KnobValue`/`KnobValueState` shape in `src/lib/types.ts` before editing (it mirrors `server/src/config/types.ts`'s `KnobValueState` — Task 10 already added `staleReason` server-side; this step is the frontend mirror) and add the field there, matching whatever the existing type is actually called.

- [ ] **Step 2: Append the failing OverrideRow test**

Append to `override-row.test.tsx` (after the existing `describe('OverrideRow — device knob', ...)` block from #1205):
```tsx
describe('OverrideRow — device knob stale_reason badge (Plan 2 §2.2)', () => {
  it('shows a distinct TEXT badge for cpu_fallback (not color alone)', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'cuda:1', source: 'override', overridden: true, staleReason: 'cpu_fallback' });
    render(<OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} gpuDevices={[]} />);
    expect(screen.getByText(/fell back to cpu/i)).toBeInTheDocument();
  });

  it('shows a distinct TEXT badge for uuid_unresolved', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'cuda-uuid:GONE', source: 'override', overridden: true, staleReason: 'uuid_unresolved' });
    render(<OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} gpuDevices={[]} />);
    expect(screen.getByText(/card (no longer|not) (found|detected)/i)).toBeInTheDocument();
  });

  it('renders no badge when staleReason is absent', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'cuda:1', source: 'override', overridden: true });
    render(<OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} gpuDevices={[]} />);
    expect(screen.queryByTestId('stale-reason-badge')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify it fails, then implement**

Run: `npx vitest run src/components/settings/override-row.test.tsx -t "stale_reason badge"` → FAIL.

In `override-row.tsx`'s `OverrideRow` component, inside the header row (167-183), add a badge next to the existing `.env` pill:
```tsx
function staleReasonLabel(reason: StaleReason): string {
  switch (reason) {
    case 'cpu_fallback': return 'fell back to CPU';
    case 'uuid_unresolved': return 'card no longer found';
  }
}

// Inside OverrideRow's header row, after the existing locked/apply pill block:
{value.staleReason && (
  <span
    data-testid="stale-reason-badge"
    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 text-[11px] font-semibold"
  >
    {staleReasonLabel(value.staleReason)}
  </span>
)}
```
(Text-based label satisfies the "not by color alone" requirement — the amber background is decoration, the label itself carries the meaning and is read by a screen reader.)

- [ ] **Step 4: Run green**

Run: `npx vitest run src/components/settings/override-row.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/components/settings/override-row.tsx src/components/settings/override-row.test.tsx
git commit -m "feat(frontend): stale_reason badge on device rows (Plan 2 §2.2)"
```

---

### Task 13: Server — plumb live resident/stale_reason data through `/api/gpu/devices` (§2.2 plumbing prerequisite)

**Files:**
- Modify: `server/src/routes/gpu-devices.ts` (merge in `resident[]`/`stale_reason`/`torch_reserved_mb` from the sidecar's `/health` `gpus[]`, not just the static `/devices` list)
- Modify: `src/lib/types.ts` (`GpuDevice` gains `resident?`/`torchReservedMb?` — Step 4)
- Modify: `src/views/advanced.tsx` (`deriveStaleReason` helper + threading it into each device `OverrideRow` — Step 4)
- Modify (APPEND): `server/src/routes/gpu-devices.test.ts`, `src/views/advanced.test.tsx`

**Why this is needed:** the frontend's `staleReason` badge (Task 12) needs to know, PER DEVICE KNOB, whether ITS engine fell back to CPU — that's `stale_reason:'cpu_fallback'` on a specific `resident[]` entry in the sidecar's `/health` `gpus[]` (Wave 1), which today's `GET /api/gpu/devices` proxy (Task from Wave 1, `gpu-devices.ts`) does NOT forward — it only proxies the static `/devices` list (`{devices:[],cpu:true}` shape, confirmed by direct read at plan-authoring time). This task merges the two.

- [ ] **Step 1: Append the failing test**

```ts
describe('GET /api/gpu/devices — merges live resident/stale_reason data (Plan 2 §2.2)', () => {
  it('includes resident and stale_reason per device from the sidecar /health', async () => {
    mockSidecarDevices([{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }]);
    mockSidecarHealth({
      gpus: [{ uuid: 'GPU-1', idx: 1, resident: [{ engine: 'qwen', actual_card: 1 }], torch_reserved_mb: 4000 }],
    });
    const res = await request(app).get('/api/gpu/devices');
    expect(res.body.devices[0].resident).toEqual([{ engine: 'qwen', actual_card: 1 }]);
    expect(res.body.devices[0].torchReservedMb).toBe(4000);
  });

  it('falls back to devices-only (no resident field) when /health is unreachable', async () => {
    mockSidecarDevices([{ uuid: 'GPU-1', idx: 1, name: 'x', total_mb: 16000, free_mb: 14000 }]);
    mockSidecarHealthUnreachable();
    const res = await request(app).get('/api/gpu/devices');
    expect(res.body.devices[0].resident).toBeUndefined();
  });
});
```
> `mockSidecarDevices`/`mockSidecarHealth`/`mockSidecarHealthUnreachable` are placeholders — match `gpu-devices.test.ts`'s EXISTING fetch-mock convention (it already mirrors `sidecar-health.test.ts`'s pattern per Wave 1's plan) rather than inventing new helpers.

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `cd server && npx vitest run src/routes/gpu-devices.test.ts -t "resident"` → FAIL.

In `gpu-devices.ts`, after the existing `/devices` fetch succeeds, ALSO fetch `/health` (same sidecar, same timeout budget) and merge:
```ts
gpuDevicesRouter.get('/devices', async (_req: Request, res: Response) => {
  const url = getResolvedSidecarUrl();
  const target = `${url}/devices`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!upstream.ok) {
      return res.json({ devices: [], cpu: true });
    }
    const body = (await upstream.json().catch(() => ({ devices: [], cpu: true }))) as {
      devices: Array<{ uuid: string; idx: number; name: string; total_mb: number; free_mb: number }>;
      cpu: boolean;
    };
    setLastKnownGpuDevices(body.devices.map((d) => ({ uuid: d.uuid, idx: d.idx })));  // Task 10's cache
    const merged = await mergeResidentData(url, body.devices);
    return res.json({ devices: merged, cpu: body.cpu });
  } catch {
    clearTimeout(timer);
    return res.json({ devices: [], cpu: true });
  }
});

/** Best-effort merge of /health gpus[] resident/stale_reason/torch_reserved_mb
    onto the static /devices list. A /health failure (timeout, unreachable)
    degrades gracefully to the devices-only shape — resident data is a
    nice-to-have annotation, never a reason to fail the whole response. */
async function mergeResidentData(
  sidecarUrl: string,
  devices: Array<{ uuid: string; idx: number; name: string; total_mb: number; free_mb: number }>,
) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(`${sidecarUrl}/health`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return devices;
    const health = (await res.json().catch(() => ({}))) as { gpus?: Array<Record<string, unknown>> };
    const byIdx = new Map((health.gpus ?? []).map((g) => [g.idx as number, g]));
    return devices.map((d) => {
      const g = byIdx.get(d.idx);
      if (!g) return d;
      return {
        ...d,
        resident: g.resident,
        torchReservedMb: g.torch_reserved_mb,
      };
    });
  } catch {
    return devices;
  }
}
```
Add the import: `import { setLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';`

- [ ] **Step 3: Run green**

Run: `cd server && npx vitest run src/routes/gpu-devices.test.ts`
Expected: PASS.

- [ ] **Step 4: Update `GpuDevice` frontend type + `AdvancedView`'s per-row `staleReason` derivation**

`src/lib/types.ts` — extend `GpuDevice` with optional `resident?: Array<{engine: string; actual_card: number | null; stale_reason?: string}>` and `torchReservedMb?: number`.

`src/views/advanced.tsx` — for each device-typed `OverrideRow`, derive `staleReason` from the matching `gpuDevices` entry's `resident[]` where `entry.engine` matches the row's engine (Qwen/Coqui/Kokoro) — this requires knowing which engine a given `descriptor.key` maps to (`tts.qwen.device` → `qwen`, etc.). Add a small local helper in `advanced.tsx`:
```tsx
function engineForDeviceKnob(key: string): string | null {
  if (key === 'tts.qwen.device') return 'qwen';
  if (key === 'tts.coqui.device') return 'coqui';
  if (key === 'tts.kokoro.device') return 'kokoro';
  return null;
}

function deriveStaleReason(descriptor: KnobDescriptor, value: KnobValue, gpuDevices: GpuDevice[]): StaleReason | undefined {
  if (value.staleReason) return value.staleReason; // env_shadow/uuid_unresolved already set server-side (resolveKnob)
  const engine = engineForDeviceKnob(descriptor.key);
  if (!engine) return undefined;
  for (const d of gpuDevices) {
    const entry = d.resident?.find((r) => r.engine === engine);
    if (entry?.stale_reason === 'cpu_fallback') return 'cpu_fallback';
  }
  return undefined;
}
```
Pass `deriveStaleReason(descriptor, values[descriptor.key], gpuDevices)` as a new `staleReason` prop into `OverrideRow` at its render call site (~308) — extend `OverrideRowProps` to accept it and pass it through to `value.staleReason` used by Task 12's badge (simplest: merge it into the `value` object passed down, e.g. `{...values[descriptor.key], staleReason: deriveStaleReason(...)}`).

Append an `advanced.test.tsx` case verifying a Qwen row shows the cpu_fallback badge when the mocked `getGpuDevices()` response includes a `resident` entry with `engine:'qwen', stale_reason:'cpu_fallback'`.

- [ ] **Step 5: Run green**

Run: `npx vitest run src/views/advanced.test.tsx src/components/settings/override-row.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/gpu-devices.ts server/src/routes/gpu-devices.test.ts src/lib/types.ts src/views/advanced.tsx src/views/advanced.test.tsx
git commit -m "feat(server,frontend): merge live resident/stale_reason data into the device picker (Plan 2 §2.2)"
```

---

### Task 14: Footprint pre-warn before a device change applies (§2.2 footprint half)

**Files:**
- Modify: `src/components/settings/override-row.tsx` (compute a warning when the selected card's free VRAM looks too small for the engine's known peak footprint)
- Modify (APPEND): `src/components/settings/override-row.test.tsx`

**Peak footprint values (from the design spec's Round 5/§2.2 text — "Qwen ~6.5 GB; Coqui ~3 GB"):** hardcode a small lookup; Kokoro's peak (~1 GB, per CLAUDE.md's "Suggested follow-ups" section) rounds out the three device-typed engines.

- [ ] **Step 1: Append the failing test**

```tsx
describe('OverrideRow — device knob footprint pre-warn (Plan 2 §2.2)', () => {
  it('warns when the selected card free_mb is well under the engine peak', () => {
    const descriptor = makeDescriptor({ key: 'tts.qwen.device', type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    const onChange = vi.fn();
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()}
        gpuDevices={[{ uuid: 'GPU-0', idx: 0, name: 'Small Card', total_mb: 4000, free_mb: 2000 }]} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cuda:0' } });
    expect(screen.getByText(/may not have enough free vram/i)).toBeInTheDocument();
  });

  it('does not warn when the selected card has ample free VRAM', () => {
    const descriptor = makeDescriptor({ key: 'tts.qwen.device', type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()}
        gpuDevices={[{ uuid: 'GPU-1', idx: 1, name: 'Big Card', total_mb: 16000, free_mb: 14000 }]} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cuda:1' } });
    expect(screen.queryByText(/may not have enough free vram/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `npx vitest run src/components/settings/override-row.test.tsx -t "footprint"` → FAIL.

Add near the top of `override-row.tsx`:
```tsx
// Peak VRAM footprint per device-typed engine (MB) — first-cut estimates per
// the design spec's §2.2 text, not measured; a false-positive warning here is
// low-cost (it's advisory, doesn't block the change) so precision isn't critical.
const ENGINE_PEAK_MB: Record<string, number> = {
  'tts.qwen.device': 6500,
  'tts.coqui.device': 3000,
  'tts.kokoro.device': 1000,
};
```
In `KnobControl`'s `device` branch, track a local warning state (the component is currently stateless/props-only — add a small `useState` for the pending-selection warning, scoped to this control only):
```tsx
  const [footprintWarning, setFootprintWarning] = useState<string | null>(null);

  // Inside the device branch's onChange:
  onChange={(e) => {
    const selected = e.target.value;
    const device = (gpuDevices ?? []).find((d) => `cuda:${d.idx}` === selected);
    const peak = ENGINE_PEAK_MB[descriptor.key];
    if (device && peak && device.free_mb < peak) {
      setFootprintWarning(
        `${device.name} may not have enough free VRAM (${device.free_mb} MB free, ~${peak} MB typically needed).`,
      );
    } else {
      setFootprintWarning(null);
    }
    onChange(selected);
  }}
```
And render it below the `<select>` (inside the `device` branch's return, or bubbled up — simplest: render inline right after the `<select>`):
```tsx
{footprintWarning && (
  <p className="text-xs text-amber-700 mt-1" role="status">{footprintWarning}</p>
)}
```
> `KnobControl` is currently a plain function component with no hooks — adding `useState` here is a genuinely new capability, not a refactor of existing state. Import `useState` from `'react'` at the top of the file.

- [ ] **Step 3: Run green**

Run: `npx vitest run src/components/settings/override-row.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/override-row.tsx src/components/settings/override-row.test.tsx
git commit -m "feat(frontend): footprint pre-warn on a device selection (Plan 2 §2.2)"
```

---

### Task 15: Analyzer read-only row (§2.4)

**Files:**
- Modify: `src/views/advanced.tsx` (add a read-only row in the "Voice engine & device" section showing the analyzer's GPU/CPU/unknown placement + a link)
- Modify: `server/src/routes/config.ts` or a new tiny route (surface `detectOllamaDevice()`'s result to the frontend — check whether an existing endpoint already does this before adding one)
- Modify (APPEND): `src/views/advanced.test.tsx`

- [ ] **Step 1: Check for an existing analyzer-device endpoint before adding one**

Run: `grep -rn "detectOllamaDevice" server/src/routes` — if a route already surfaces this (likely, since Wave 2 Task 8 already wires cache-population at its call sites), reuse it. If not, add a minimal one:
```ts
// in whichever router already exposes analyzer status (grep for it — likely
// an existing /api/analyzer/* or /api/ollama/* router) — add:
router.get('/device', async (_req, res) => {
  res.json({ device: await detectOllamaDevice() });
});
```

- [ ] **Step 2: Append the failing frontend test**

```tsx
describe('AdvancedView — analyzer read-only row (Plan 2 §2.4)', () => {
  it('shows the analyzer GPU/CPU/unknown placement, not editable', async () => {
    mockGetAnalyzerDevice('cuda');
    render(<AdvancedView />, { wrapper: withStore });
    await screen.findByText(/analyzer/i);
    expect(screen.getByText(/gpu/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /analyzer/i })).not.toBeInTheDocument();
  });

  it('links to the documented OS-env path', async () => {
    mockGetAnalyzerDevice('cpu');
    render(<AdvancedView />, { wrapper: withStore });
    const link = await screen.findByRole('link', { name: /change.*analyzer.*device|local-llm/i });
    expect(link).toHaveAttribute('href', expect.stringMatching(/local-llm/));
  });
});
```

- [ ] **Step 3: Run to verify it fails, then implement**

Run: `npx vitest run src/views/advanced.test.tsx -t "analyzer read-only"` → FAIL.

Add `api.getAnalyzerDevice()` to `src/lib/api.ts` (mirrors `getGpuDevices`'s mock/real split), fetch it in `AdvancedView`'s mount `useEffect` alongside `gpuDevices`, and render a read-only row in the device section:
```tsx
<div className="py-3 border-b border-ink/8">
  <div className="flex items-center gap-2 mb-1">
    <span className="text-sm font-medium text-ink flex-1">Analyzer (Ollama) device</span>
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-ink/8 text-ink/60 text-[11px] font-semibold">
      read-only
    </span>
  </div>
  <p className="text-xs text-ink/55 mb-1">
    {analyzerDevice === 'cuda' ? 'GPU' : analyzerDevice === 'cpu' ? 'CPU' : 'Unknown'} — not app-pinnable; the
    analyzer connects to a user/OS-managed Ollama daemon.
  </p>
  <a href="/docs/local-llm.md" className="text-xs text-magenta hover:underline">
    Change the analyzer's device (documented OS-env steps)
  </a>
</div>
```
(Gate this row's visibility on `ANALYZER === 'local'` per the spec's §2.4 — check how the frontend already knows the resolved `ANALYZER` mode, likely already exposed via an existing config value/env-status endpoint; reuse it rather than adding a new one.)

- [ ] **Step 4: Run green**

Run: `npx vitest run src/views/advanced.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/advanced.tsx src/views/advanced.test.tsx src/lib/api.ts src/lib/types.ts server/src/routes/*.ts
git commit -m "feat(frontend,server): analyzer read-only device row (Plan 2 §2.4)"
```

---

### Task 16: Auto-revert — consumes Wave 2's trip event (§2.3)

**Files:**
- Create: `server/src/routes/gpu-auto-revert.ts` (or fold into an existing sidecar-admin route — check first) — `POST /api/gpu/auto-revert` (or a background check) reads `supervisor.tripEvent()`, picks a DIFFERENT safe card (or CPU) for the offending engine(s), writes the override, and calls `supervisor.clearTripAndRespawn()` (Task 7) to actually bring TTS back — **a round-3 review finding: an earlier draft wrote the override and stopped there, never restarting anything, while claiming "triggers a restart" — that was false; this is now real.**
- Modify (APPEND): a new test file for the revert-selection logic.

**Selection rule (spec §2.3, verified against Task 7's `tripEvent()` shape):** revert the engine(s) on the tripped card to a DIFFERENT safe card or CPU — explicitly NOT the knob default `auto`→cuda:0, which could re-land on the same undersized card. Recovery is only complete once `clearTripAndRespawn()` (Task 7) actually spawns a fresh sidecar — the config rewrite alone does nothing until a new process reads it.

- [ ] **Step 1: Write the failing test for the pure selection function**

`server/src/gpu/auto-revert-selection.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { selectRevertTarget } from './auto-revert-selection.js';

describe('selectRevertTarget', () => {
  it('picks a different card with enough free VRAM over the tripped one', () => {
    const target = selectRevertTarget({
      trippedCardIdx: 0,
      candidates: [{ idx: 0, freeMb: 500 }, { idx: 1, freeMb: 14000 }],
      requiredMb: 3000,
    });
    expect(target).toBe('cuda:1');
  });

  it('falls back to cpu when no other card has enough free VRAM', () => {
    const target = selectRevertTarget({
      trippedCardIdx: 0,
      candidates: [{ idx: 0, freeMb: 500 }, { idx: 1, freeMb: 1000 }],
      requiredMb: 3000,
    });
    expect(target).toBe('cpu');
  });

  it('falls back to cpu when there is only one card (the tripped one)', () => {
    const target = selectRevertTarget({ trippedCardIdx: 0, candidates: [{ idx: 0, freeMb: 8000 }], requiredMb: 3000 });
    expect(target).toBe('cpu');
  });

  it('never returns "auto" — the default that could re-land on the same card', () => {
    const target = selectRevertTarget({ trippedCardIdx: 0, candidates: [], requiredMb: 3000 });
    expect(target).not.toBe('auto');
  });
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `cd server && npx vitest run src/gpu/auto-revert-selection.test.ts` → FAIL.

`server/src/gpu/auto-revert-selection.ts`:
```ts
/* Plan 2 §2.3 — pick a revert target for an engine whose card just tripped
   the Wave 2 §W2.5 code-43 streak guard. NEVER 'auto' (could re-land on the
   same undersized card via cuda:0); prefer a DIFFERENT card with enough free
   VRAM; fall back to 'cpu' when none qualifies. */

export interface RevertCandidate { idx: number; freeMb: number }

export function selectRevertTarget(args: {
  trippedCardIdx: number;
  candidates: RevertCandidate[];
  requiredMb: number;
}): string {
  const other = args.candidates.filter((c) => c.idx !== args.trippedCardIdx && c.freeMb >= args.requiredMb);
  if (other.length > 0) {
    // Prefer the candidate with the MOST free VRAM — the safest landing spot.
    const best = other.reduce((a, b) => (b.freeMb > a.freeMb ? b : a));
    return `cuda:${best.idx}`;
  }
  return 'cpu';
}
```

- [ ] **Step 3: Run green**

Run: `cd server && npx vitest run src/gpu/auto-revert-selection.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire the revert action (write the override + restart)**

**Status is a state machine, not a boolean** (a round-2 adversarial review found the original boolean `revertible` design leaves `lastAutoRevertOutcome` — Task 16.5 — durably wrong forever if `runAutoRevert` throws mid-loop, since nothing ever assigns past that point): `'pending' -> 'reverted' | 'unrevertable' | 'failed'`. `'pending'` is the value BOTH before any trip has ever happened AND for the brief window between a trip being detected and `runAutoRevert` resolving — so a `/trip-status` poll landing in that window reports "still working on it," never a wrong terminal state.

Write a failing test for the wiring in a new `gpu-auto-revert.test.ts` (route-level, mocking `getActiveSupervisor()` — its `tripEvent()` AND its `clearTripAndRespawn()` (a `vi.fn()` resolving `undefined`; **NOT** `restartSidecar` — no such symbol exists anywhere in the codebase, an earlier draft of this plan named a collaborator that was never real), `getGpuDevices()`, and `writeConfigOverride`, the same way `advanced.test.tsx`/`config.test.ts` already mock their respective collaborators — include cases for: `tripEvent()` returning `{card: null, residentEngines: []}` (asserts `status: 'unrevertable'`, `reverted: []`, a distinct error-level log, AND that `clearTripAndRespawn` is NOT called — there's nothing to recover into); `writeConfigOverride` mocked to reject (asserts `status: 'failed'`, not an uncaught throw, and `clearTripAndRespawn` NOT called since the loop never completed); AND a successful revert (asserts `status: 'reverted'` AND `clearTripAndRespawn` WAS called exactly once)), then implement `server/src/routes/gpu-auto-revert.ts`:
```ts
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getActiveSupervisor } from '../tts/sidecar-supervisor.js';
import { getLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';
import { selectRevertTarget } from '../gpu/auto-revert-selection.js';
import { writeConfigOverride } from '../workspace/user-settings.js';
import { getKnob } from '../config/registry.js';

const ENGINE_PEAK_MB: Record<string, number> = { qwen: 6500, coqui: 3000, kokoro: 1000 };
const ENGINE_KNOB_KEY: Record<string, string> = {
  qwen: 'tts.qwen.device', coqui: 'tts.coqui.device', kokoro: 'tts.kokoro.device',
};

export const gpuAutoRevertRouter = Router();

export type AutoRevertStatus = 'pending' | 'reverted' | 'unrevertable' | 'failed';

export interface AutoRevertResult {
  status: AutoRevertStatus;
  reverted: string[];
}

/** Task 16.5's last-outcome cache. Starts (and resets) at 'pending' rather
    than a terminal state, so the gap between a trip being detected
    (supervisor sets tripEvent() synchronously) and runAutoRevert resolving
    never reads as a wrong terminal answer — 'pending' is honest about "still
    working on it." Exported so Task 16.5's route can read it and so tests
    can reset it between cases (a round-2 review finding: a module-level
    cache with no reset hook makes test order load-bearing). */
export let lastAutoRevertOutcome: AutoRevertResult = { status: 'pending', reverted: [] };

/** Test-only: reset the last-outcome cache between test cases. */
export function resetAutoRevertOutcomeForTest(): void {
  lastAutoRevertOutcome = { status: 'pending', reverted: [] };
}

/** Core auto-revert logic (Plan 2 §2.3). Reads the active supervisor's trip
    event (Wave 2 §W2.5) and, if it names a specific card, reverts every
    resident engine on that card to a different safe card or CPU. Two
    non-'reverted' outcomes, both logged distinctly (an adversarial-review
    finding: neither may silently read as "handled" by Task 16.5's surfaced
    status):
      - 'unrevertable' — the trip has NO card (a host-RAM leak or the
        pre-Wave-2 device-0 VRAM ceiling can ALSO trip the streak guard —
        Tasks 6/7 count ANY code-43). There is no device knob to revert.
      - 'failed' — a card WAS attributable but something in the revert loop
        (most likely writeConfigOverride) threw. The whole function is
        wrapped in try/catch specifically so a throw can never leave
        lastAutoRevertOutcome stuck at 'pending' forever — every path,
        including this one, reaches an assignment. */
export async function runAutoRevert(
  trip: { card: unknown; residentEngines: string[] } | null,
): Promise<AutoRevertResult> {
  lastAutoRevertOutcome = { status: 'pending', reverted: [] };
  try {
    if (!trip || !trip.card || typeof (trip.card as any).idx !== 'number' || trip.residentEngines.length === 0) {
      console.error(
        '[gpu] auto-revert: the code-43 streak guard tripped WITHOUT a specific card attributed ' +
          '(trip=%s) — likely a host-RAM leak or a device-0 VRAM ceiling breach, NOT a per-card ' +
          'device-placement issue. There is no device knob to revert. TTS remains held down; this ' +
          'requires MANUAL investigation (check server/sidecar logs for the restart history), not ' +
          'an automatic fix.',
        JSON.stringify(trip),
      );
      lastAutoRevertOutcome = { status: 'unrevertable', reverted: [] };
      return lastAutoRevertOutcome;
    }
    const trippedIdx = (trip.card as { idx: number }).idx;
    const devices = getLastKnownGpuDevices();
    const reverted: string[] = [];
    for (const engine of trip.residentEngines) {
      const knobKey = ENGINE_KNOB_KEY[engine];
      if (!knobKey) continue;
      const knob = getKnob(knobKey);
      if (!knob) continue;
      const target = selectRevertTarget({
        trippedCardIdx: trippedIdx,
        candidates: devices.map((d) => ({ idx: d.idx, freeMb: d.freeMb })),
        requiredMb: ENGINE_PEAK_MB[engine] ?? 0,
      });
      await writeConfigOverride(knobKey, target);
      reverted.push(`${engine} -> ${target}`);
    }
    // A round-3 adversarial review finding: without this call, 'reverted' was
    // a LIE — the config override was written but nothing ever cleared the
    // supervisor's trip latch or spawned a fresh child, so TTS stayed dead
    // even on the "successful" path. clearTripAndRespawn() (Task 7) is the
    // ONLY way back from a trip — the pre-existing POST /api/sidecar/restart
    // route requires a currently-running child to kill, and a tripped
    // supervisor has none.
    await getActiveSupervisor()?.clearTripAndRespawn();
    lastAutoRevertOutcome = { status: 'reverted', reverted };
    return lastAutoRevertOutcome;
  } catch (err) {
    // Catches a writeConfigOverride rejection AND a clearTripAndRespawn()
    // failure alike — either way, the operator needs to know TTS did NOT
    // come back cleanly and must investigate manually. (If overrides were
    // written but the respawn itself failed, the rewritten config still
    // takes effect on the NEXT successful restart — not lost, just not
    // applied automatically this time.)
    console.error(
      '[gpu] auto-revert: threw while attempting to revert a tripped, card-attributable device ' +
        'assignment (%s) — TTS remains held down. This requires MANUAL investigation.',
      (err as Error).message,
    );
    lastAutoRevertOutcome = { status: 'failed', reverted: [] };
    return lastAutoRevertOutcome;
  }
}

gpuAutoRevertRouter.post('/auto-revert', async (_req: Request, res: Response) => {
  const trip = getActiveSupervisor()?.tripEvent() ?? null;
  res.json(await runAutoRevert(trip));
});
```
> `getLastKnownGpuDevices()` (Task 10) only caches `{uuid, idx}`, not `free_mb` — extend that cache's shape to also carry `freeMb` (a one-line widen of `GpuDeviceInfo` in `gpu-device-list-state.ts` + its population site in `gpu-devices.ts`, where `body.devices` already carries `free_mb` per-card) so `selectRevertTarget`'s `requiredMb` comparison has real data instead of always falling back to `cpu`. Do this as part of this step, not a follow-up — the revert logic is meaningless without it.

- [ ] **Step 5: Run green**

Run: `cd server && npx vitest run src/gpu/auto-revert-selection.test.ts src/routes/gpu-auto-revert.test.ts`
Expected: PASS.

- [ ] **Step 6: Mount the route + trigger it**

Mount `gpuAutoRevertRouter` in `app.ts` near the other `/api/gpu` routes. Trigger it automatically the moment a trip is detected (the spec frames this as "auto-revert", not a manual button — Task 16.5 adds the operator-facing VISIBILITY on top, it doesn't change the trigger): inside `sidecar-supervisor.ts`'s trip branch (Task 7), after `warn(...)`, add:
```ts
        void import('../routes/gpu-auto-revert.js')
          .then(({ runAutoRevert }) => runAutoRevert(restart43Trip))
          .catch((err) => {
            // runAutoRevert itself catches everything internally (Step 4) — this
            // .catch only covers the dynamic import() call failing outright (a
            // round-2 review finding: the original fire-and-forget had no .catch
            // at all, so an import failure would surface as an unhandled
            // rejection instead of a diagnosable log line).
            warn(`[sidecar] supervisor: auto-revert dynamic import failed (${(err as Error).message}) — TTS remains held down.`);
          });
```
(`runAutoRevert` — exported directly from Step 4's implementation, not a separate refactor — handles every outcome via its `'pending'->'reverted'|'unrevertable'|'failed'` status machine and logs distinctly on every non-`'reverted'` path; nothing further to add here.)

- [ ] **Step 7: Run the full server suite**

Run: `cd server && npm run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/gpu/auto-revert-selection.ts server/src/gpu/auto-revert-selection.test.ts server/src/routes/gpu-auto-revert.ts server/src/routes/gpu-auto-revert.test.ts server/src/gpu/gpu-device-list-state.ts server/src/tts/sidecar-supervisor.ts server/src/app.ts
git commit -m "feat(server): auto-revert a tripped device assignment to a safe card or CPU (Plan 2 §2.3)"
```

---

### Task 16.5: Surface a held-TTS trip to the operator — never silent (closes an adversarial-review finding)

**Why this task exists:** an adversarial review of this plan (assumption-checker pass, 2026-07-02) found that when the code-43 streak guard trips WITHOUT a specific card (a host-RAM leak, or the pre-Wave-2 device-0 VRAM scalar ceiling, crash-looping 3×/10min — Tasks 6/7 count ANY code-43, not just per-card ones), Task 16's `runAutoRevert` correctly declines to guess a revert target, but — before this task — that outcome was only a server-log line. TTS stays held down (Task 7's supervisor stops respawning once tripped) with **no path back to running short of an operator noticing the log and manually restarting the server**, and no UI signal at all that anything is wrong beyond "generation stopped working." The user's explicit instruction on the review finding: *"need to address, can't just silently die."* This task makes the held-down state, and whether it was auto-remediated, visible in Advanced Configuration — it does not change what Task 16 does or doesn't revert, only whether anyone can SEE the outcome without reading server logs.

**Files:**
- Modify: `server/src/routes/gpu-auto-revert.ts` (add `GET /api/gpu/trip-status`, persist the LAST `runAutoRevert` outcome so the status route can report it)
- Modify: `server/src/tts/sidecar-supervisor.ts` (expose the trip on `SidecarSupervisor` in a form Step 1 below can query — `tripEvent()` already exists from Task 7; this task adds nothing new to the interface, only a consumer)
- Modify: `src/lib/types.ts` (declare `export type AutoRevertStatus = 'pending' | 'reverted' | 'unrevertable' | 'failed';` and a `GpuTripStatus` interface matching the route's JSON shape — the frontend can't import the server's type, it needs its own mirror. **Explicit here because a round-3 review found this file listed but the instruction to actually add the type was never spelled out in Step 2's prose.**)
- Modify: `src/lib/api.ts` (`getGpuTripStatus()` client, returning `GpuTripStatus`)
- Modify: `src/views/advanced.tsx` (poll trip status; push a toast via the existing `notifications` slice when tripped — matches this codebase's established pattern, per `src/store/notifications-slice.ts`'s own header comment: "Closes the 'did anything happen?' gap when an analysis-stream / generation-stream / export error fires")
- Modify (APPEND): `server/src/routes/gpu-auto-revert.test.ts`, `src/views/advanced.test.tsx`

**Interfaces:**
- `GET /api/gpu/trip-status -> { tripped: boolean; status: AutoRevertStatus; reverted: string[]; card: unknown; residentEngines: string[] }` — `status`/`reverted` mirror the LAST `runAutoRevert()` call's `AutoRevertResult` (Task 16's status machine: `'pending' | 'reverted' | 'unrevertable' | 'failed'`); `tripped` is `true` whenever `supervisor.tripEvent()` is non-null. `status:'pending'` while `tripped:true` means a revert attempt is in flight RIGHT NOW — the frontend should not alarm on it (Step 2 below), only on a settled terminal status.

- [ ] **Step 1: Server — the status route, with a failing test first**

Append to `gpu-auto-revert.test.ts` — **include a `beforeEach(() => resetAutoRevertOutcomeForTest())`** (a round-2 review finding: the module-level cache has no reset hook, so test ORDER was silently load-bearing without one):
```ts
import { resetAutoRevertOutcomeForTest } from './gpu-auto-revert.js';

describe('GET /api/gpu/trip-status', () => {
  beforeEach(() => resetAutoRevertOutcomeForTest());

  it('reports not tripped, pending, when no trip has occurred', async () => {
    mockTripEvent(null);
    const res = await request(app).get('/api/gpu/trip-status');
    expect(res.body).toEqual({ tripped: false, status: 'pending', reverted: [], card: null, residentEngines: [] });
  });

  it('reports a successful revert', async () => {
    mockTripEvent({ card: { uuid: 'GPU-1', idx: 1 }, residentEngines: ['coqui'] });
    await request(app).post('/api/gpu/auto-revert'); // populates the last-outcome cache
    const res = await request(app).get('/api/gpu/trip-status');
    expect(res.body.tripped).toBe(true);
    expect(res.body.status).toBe('reverted');
    expect(res.body.reverted.length).toBeGreaterThan(0);
  });

  it('reports unrevertable when the trip has no card', async () => {
    mockTripEvent({ card: null, residentEngines: [] });
    await request(app).post('/api/gpu/auto-revert');
    const res = await request(app).get('/api/gpu/trip-status');
    expect(res.body.tripped).toBe(true);
    expect(res.body.status).toBe('unrevertable');
    expect(res.body.reverted).toEqual([]);
  });

  it('reports failed (not stuck at pending) when the revert loop throws', async () => {
    mockTripEvent({ card: { uuid: 'GPU-1', idx: 1 }, residentEngines: ['coqui'] });
    mockWriteConfigOverride.mockRejectedValueOnce(new Error('disk full'));
    await request(app).post('/api/gpu/auto-revert');
    const res = await request(app).get('/api/gpu/trip-status');
    expect(res.body.status).toBe('failed'); // NOT 'pending' — the round-2 review's top finding
  });

  it('reports tripped + pending in the window before runAutoRevert resolves', async () => {
    mockTripEvent({ card: { uuid: 'GPU-1', idx: 1 }, residentEngines: ['coqui'] });
    // deliberately do NOT await/POST /auto-revert first — simulates the gap
    // between the supervisor detecting a trip and the fire-and-forget
    // runAutoRevert() call actually resolving.
    const res = await request(app).get('/api/gpu/trip-status');
    expect(res.body.tripped).toBe(true);
    expect(res.body.status).toBe('pending'); // honest "still working on it", not a wrong terminal answer
  });
});
```
> `mockTripEvent`/`mockWriteConfigOverride` are placeholders for however this file's existing tests already mock `getActiveSupervisor()`/`writeConfigOverride` — match the established pattern from Step 1's earlier tests in this same file (Task 16), don't invent a second mocking convention.

Run: `cd server && npx vitest run src/routes/gpu-auto-revert.test.ts -t "trip-status"` → FAIL.

Implement the route (the `lastAutoRevertOutcome` cache and `resetAutoRevertOutcomeForTest` were already added by Task 16 Step 4 — this step only adds the route reading them):
```ts
gpuAutoRevertRouter.get('/trip-status', (_req: Request, res: Response) => {
  const trip = getActiveSupervisor()?.tripEvent() ?? null;
  res.json({
    tripped: trip !== null,
    status: lastAutoRevertOutcome.status,
    reverted: lastAutoRevertOutcome.reverted,
    card: trip?.card ?? null,
    residentEngines: trip?.residentEngines ?? [],
  });
});
```

Run: `cd server && npx vitest run src/routes/gpu-auto-revert.test.ts` → PASS.

- [ ] **Step 2: Frontend — poll + toast, with a failing test first**

Append to `advanced.test.tsx`:
```tsx
describe('AdvancedView — held-TTS trip alert (closes a silent-hold gap)', () => {
  it('pushes an error toast when the trip was reverted', async () => {
    mockGetGpuTripStatus({ tripped: true, status: 'reverted', reverted: ['coqui -> cuda:0'], card: { idx: 1 }, residentEngines: ['coqui'] });
    render(<AdvancedView />, { wrapper: withStore });
    await waitFor(() => expect(dispatchedToasts()).toContainEqual(
      expect.objectContaining({ kind: 'error', dedupeKey: 'gpu-trip' }),
    ));
    expect(dispatchedToasts()[0].message).toMatch(/auto-reverted|coqui/i);
  });

  it('pushes a DIFFERENT message when the trip is unrevertable (card-less streak)', async () => {
    mockGetGpuTripStatus({ tripped: true, status: 'unrevertable', reverted: [], card: null, residentEngines: [] });
    render(<AdvancedView />, { wrapper: withStore });
    await waitFor(() => expect(dispatchedToasts()).toContainEqual(
      expect.objectContaining({ kind: 'error', dedupeKey: 'gpu-trip' }),
    ));
    expect(dispatchedToasts()[0].message).toMatch(/not tied to a specific.*card|manual (investigation|restart)/i);
  });

  it('pushes a THIRD distinct message when the revert attempt itself failed', async () => {
    mockGetGpuTripStatus({ tripped: true, status: 'failed', reverted: [], card: { idx: 1 }, residentEngines: ['coqui'] });
    render(<AdvancedView />, { wrapper: withStore });
    await waitFor(() => expect(dispatchedToasts()).toContainEqual(
      expect.objectContaining({ kind: 'error', dedupeKey: 'gpu-trip' }),
    ));
    expect(dispatchedToasts()[0].message).toMatch(/revert attempt.*failed|manual (investigation|restart)/i);
  });

  it('does not toast while pending, even if tripped (revert still in flight)', async () => {
    mockGetGpuTripStatus({ tripped: true, status: 'pending', reverted: [], card: { idx: 1 }, residentEngines: ['coqui'] });
    render(<AdvancedView />, { wrapper: withStore });
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchedToasts()).toEqual([]);
  });

  it('does not toast when nothing has tripped', async () => {
    mockGetGpuTripStatus({ tripped: false, status: 'pending', reverted: [], card: null, residentEngines: [] });
    render(<AdvancedView />, { wrapper: withStore });
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchedToasts()).toEqual([]);
  });
});
```

Run: `npx vitest run src/views/advanced.test.tsx -t "held-TTS trip"` → FAIL.

Add `getGpuTripStatus()` to `src/lib/api.ts` (mirrors `getGpuDevices`'s mock/real split). In `AdvancedView`'s mount `useEffect` (the same one that fetches `gpuDevices`), add a poll:
```tsx
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await api.getGpuTripStatus();
        if (cancelled || !status.tripped || status.status === 'pending') return;
        const messageByStatus: Record<'reverted' | 'unrevertable' | 'failed', string> = {
          // Accurate as of the round-3 fix: runAutoRevert now actually calls
          // clearTripAndRespawn() before setting status:'reverted' (Task
          // 16), so "restarting" here describes something real, not an
          // aspiration — an earlier draft said "pending" while nothing was.
          reverted: `TTS was held down after repeated crashes; auto-reverted: ${status.reverted.join(', ')}. The sidecar is restarting now.`,
          unrevertable: 'TTS has been held down after repeated crashes not tied to a specific GPU card. This needs manual investigation — check the server logs, then restart the server.',
          failed: 'TTS is held down after repeated crashes, and the automatic revert attempt itself failed. This needs manual investigation — check the server logs, then restart the server.',
        };
        dispatch(pushToast({ kind: 'error', dedupeKey: 'gpu-trip', message: messageByStatus[status.status] }));
      } catch {
        // best-effort — a failed poll just means no alert this tick, not a UI error.
      }
    };
    void poll();
    const id = setInterval(poll, 30_000); // matches this codebase's existing /health poll cadence
    return () => { cancelled = true; clearInterval(id); };
  }, [dispatch]);
```
Import `pushToast` from `'../store/notifications-slice'`.

- [ ] **Step 3: Run green**

Run: `npx vitest run src/views/advanced.test.tsx` and `cd server && npx vitest run src/routes/gpu-auto-revert.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/gpu-auto-revert.ts server/src/routes/gpu-auto-revert.test.ts src/lib/api.ts src/lib/types.ts src/views/advanced.tsx src/views/advanced.test.tsx
git commit -m "feat(server,frontend): surface a held-TTS trip to the operator, revertible or not"
```

---

### Task 17: `.env` cutover WARN + e2e + a11y coverage (§2.5 remainder, Plan 2 testing)

**Files:**
- Modify: `server/tts-sidecar/main.py` (WARN log at startup when `CUDA_VISIBLE_DEVICES` is still set, per §2.5's "the sidecar WARNs if CUDA_VISIBLE_DEVICES is still set")
- Modify: `docs/local-llm.md` (document the manual `.env` cutover step — strip `COQUI/ASR/SPK_DEVICE` + the two `CUDA_*` lines)
- Modify: `src/views/advanced.tsx` (a single `cudaEnvShadow` banner — Step 4.5, added during Plan 2a execution to close the scope gap noted in Task 12)
- Modify: `e2e/responsive/coverage.spec.ts` (add the Advanced Configuration case at 3 viewports, per this codebase's "adding a new view? append a case here" convention)
- Create: `e2e/gpu-device-badge.spec.ts` (asserts the `fell_back`/`cpu_fallback` badge against a mocked `/health`)
- Modify: `src/test/a11y.test.tsx` (APPEND a new `describe('a11y — advanced configuration view', ...)` block)
- Modify (APPEND): `server/tts-sidecar/tests/test_runtime_wiring.py` or a new small test file for the startup WARN, `src/views/advanced.test.tsx`

- [ ] **Step 1: Sidecar startup WARN — write the failing test**

```python
def test_startup_warns_when_cuda_visible_devices_still_set(monkeypatch, caplog):
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "1,0")
    import logging
    caplog.set_level(logging.WARNING)
    main._warn_if_cuda_env_shadow_active()
    assert any("CUDA_VISIBLE_DEVICES" in r.message for r in caplog.records)


def test_startup_silent_when_cuda_visible_devices_unset(monkeypatch, caplog):
    monkeypatch.delenv("CUDA_VISIBLE_DEVICES", raising=False)
    import logging
    caplog.set_level(logging.WARNING)
    main._warn_if_cuda_env_shadow_active()
    assert not any("CUDA_VISIBLE_DEVICES" in r.message for r in caplog.records)
```
Place this in a new small file `server/tts-sidecar/tests/test_cuda_env_shadow.py` (mirrors the other small single-concern test files already in this directory).

- [ ] **Step 2: Run to verify it fails, then implement**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_cuda_env_shadow.py -v` → FAIL.

Near the other startup hooks in `main.py`:
```python
def _warn_if_cuda_env_shadow_active() -> None:
    """Plan 2 §2.5 cutover nudge: CUDA_VISIBLE_DEVICES/CUDA_DEVICE_ORDER are
    raw env, not knobs — the picker can surface them (server-side, Task 11)
    but can't CLEAR them (that's a manual .env edit, documented in
    docs/local-llm.md). WARN once at boot so an operator who's moved to the
    picker knows a stale env var is still shadowing it."""
    if os.environ.get("CUDA_VISIBLE_DEVICES") or os.environ.get("CUDA_DEVICE_ORDER"):
        log.warning(
            "CUDA_VISIBLE_DEVICES/CUDA_DEVICE_ORDER is set in the environment — it overrides "
            "every per-engine device pin set via the Advanced Configuration picker. If you've "
            "moved to per-engine pins, remove these two lines from server/.env (see "
            "docs/local-llm.md's cutover section)."
        )


@app.on_event("startup")
async def _startup_cuda_env_shadow_check() -> None:
    _warn_if_cuda_env_shadow_active()
```

- [ ] **Step 3: Run green**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_cuda_env_shadow.py -v`
Expected: PASS.

- [ ] **Step 4: Document the cutover in `docs/local-llm.md`**

Add a short section (read the existing doc's structure first, match its heading level/style):
```markdown
## Moving from CUDA_VISIBLE_DEVICES to per-engine pins

If you previously set `CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=1,0`
in `server/.env` as a multi-GPU stop-gap, the Advanced Configuration device
picker (Voice engine & device) now replaces it with per-engine pins that
survive a driver renumber. To cut over:

1. Set each engine's device (Qwen/Coqui/Kokoro) explicitly in Advanced
   Configuration to the card you want.
2. Remove the `CUDA_DEVICE_ORDER` and `CUDA_VISIBLE_DEVICES` lines from
   `server/.env`.
3. Restart the server (a raw env var needs a server restart, not just a
   sidecar restart — see the design spec's "Apply semantics").

The sidecar logs a WARNING at startup if `CUDA_VISIBLE_DEVICES` is still set,
since it silently overrides every per-engine pin.
```

- [ ] **Step 4.5: Frontend — a single `cudaEnvShadow` banner (closes the Task 12 scope gap)**

Task 11 already ships `cudaEnvShadow: boolean` on `GET /api/config`'s response, but nothing on the frontend reads it yet — `ConfigResponse` (`src/lib/types.ts`) doesn't declare the field, `ConfigState` (`src/store/config-slice.ts`) doesn't store it, and `AdvancedView` doesn't render it. This step wires all three.

Append a failing test to `src/views/advanced.test.tsx`:
```tsx
describe('AdvancedView — CUDA env-shadow banner (Plan 2 §2.5)', () => {
  it('shows a banner when cudaEnvShadow is true', async () => {
    vi.spyOn(api, 'getConfig').mockResolvedValueOnce({
      groups: [], descriptors: [], values: {}, restartPending: false, cudaEnvShadow: true,
    });
    render(<AdvancedView />, { wrapper: withStore });
    await screen.findByText(/CUDA_VISIBLE_DEVICES/i);
  });

  it('shows no banner when cudaEnvShadow is false', async () => {
    vi.spyOn(api, 'getConfig').mockResolvedValueOnce({
      groups: [], descriptors: [], values: {}, restartPending: false, cudaEnvShadow: false,
    });
    render(<AdvancedView />, { wrapper: withStore });
    await waitFor(() => expect(screen.queryByText(/CUDA_VISIBLE_DEVICES/i)).not.toBeInTheDocument());
  });
});
```
(Match this file's ACTUAL existing `api.getConfig` mocking convention — `grep -n "getConfig" src/views/advanced.test.tsx` first; the shape above is illustrative, adapt to however the file already spies on/mocks the config fetch.)

Run: `npx vitest run src/views/advanced.test.tsx -t "env-shadow banner"` → FAIL.

`src/lib/types.ts` — add the field to the existing `ConfigResponse` interface:
```ts
export interface ConfigResponse {
  groups: ConfigGroup[];
  descriptors: KnobDescriptor[];
  values: ConfigValues;
  restartPending: boolean;
  cudaEnvShadow: boolean;
}
```

`src/lib/api.ts` — add `cudaEnvShadow: false` to `mockGetConfig`'s returned object (mock/real parity; `realGetConfig` needs no change, it already forwards the server's full JSON body).

`src/store/config-slice.ts` — add to `ConfigState`:
```ts
export interface ConfigState {
  groups: ConfigGroup[];
  descriptors: KnobDescriptor[];
  values: ConfigValues;
  status: ConfigStatus;
  error: string | null;
  hydrated: boolean;
  cudaEnvShadow: boolean;
}
```
Add `cudaEnvShadow: false` to `initialState`, and in the `fetchConfig.fulfilled` case:
```ts
      .addCase(fetchConfig.fulfilled, (s, a) => {
        s.groups = a.payload.groups;
        s.descriptors = a.payload.descriptors;
        s.values = a.payload.values;
        s.cudaEnvShadow = a.payload.cudaEnvShadow;
        s.status = 'idle';
        s.error = null;
        s.hydrated = true;
      })
```

`src/views/advanced.tsx` — read `cudaEnvShadow` from the config slice (same `useAppSelector((s) => s.config)` destructure `AdvancedView` already uses) and render a banner in the existing "Banners" block, alongside `RestartSidecarBanner`/the restart-server banner:
```tsx
const { groups, descriptors, values, status, error, hydrated, cudaEnvShadow } = useAppSelector((s) => s.config);
```
```tsx
{cudaEnvShadow && (
  <div className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-3">
    <p className="text-sm text-amber-800">
      <code className="font-mono">CUDA_VISIBLE_DEVICES</code>/<code className="font-mono">CUDA_DEVICE_ORDER</code> is
      set in <code className="font-mono">server/.env</code> — it overrides every device pin below. See{' '}
      <a href="/docs/local-llm.md" className="underline">docs/local-llm.md</a> to switch to per-engine pins.
    </p>
  </div>
)}
```

- [ ] **Step 4.6: Run green**

Run: `npx vitest run src/views/advanced.test.tsx`
Expected: PASS.

- [ ] **Step 5: e2e — append the responsive-coverage case**

In `e2e/responsive/coverage.spec.ts`, add the Advanced Configuration entry alongside the other views (match the existing array/table-driven structure in that file exactly — read it first).

- [ ] **Step 6: e2e — `fell_back`/`cpu_fallback` badge assertion**

`e2e/gpu-device-badge.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test('device row shows a cpu_fallback badge when the mocked sidecar health reports one', async ({ page }) => {
  await page.route('**/api/gpu/devices', (route) =>
    route.fulfill({ json: { devices: [{ uuid: 'GPU-0', idx: 0, name: 'Test Card', total_mb: 8000, free_mb: 6000, resident: [{ engine: 'qwen', actual_card: null, stale_reason: 'cpu_fallback' }] }], cpu: true } }),
  );
  await page.goto('/#/admin/advanced');
  await expect(page.getByText(/fell back to cpu/i)).toBeVisible();
});
```
> Verify the actual hash-route path for Advanced Configuration (`grep -n "advanced" src/lib/router.ts`) before trusting `/#/admin/advanced` — this plan's research pass did not confirm the exact route string.

- [ ] **Step 7: Run the e2e specs**

Run: `npm run test:e2e -- gpu-device-badge`
Expected: PASS.

- [ ] **Step 8: a11y — append the Advanced Configuration block**

Append to `src/test/a11y.test.tsx` (match the EXACT pattern of the existing 5 `describe('a11y — ... view', ...)` blocks — `configureStore` + `axe(container, AXE_OPTS)`):
```tsx
describe('a11y — advanced configuration view', () => {
  it('has no axe violations', async () => {
    const store = configureStore({ /* match the existing blocks' setup exactly */ });
    const { container } = render(<Provider store={store}><AdvancedView /></Provider>);
    const results = await axe(container, AXE_OPTS);
    expect(results).toHaveNoViolations();
  });
});
```
Run: `npx vitest run src/test/a11y.test.tsx -t "advanced configuration"` — if it fails on a genuine finding (not a setup mistake), fix the underlying markup (most likely candidate: the new footprint-warning `<p role="status">` or the stale-reason badge needing an `aria-live` region so a screen-reader user gets the update) rather than adding an `AXE_OPTS` exemption — only exempt a rule if a real violation turns out to be unfixable, matching this file's own stated convention ("a fresh block... starts from full rules unless a real finding forces an exemption").

- [ ] **Step 9: Run everything green**

Run: `npx vitest run src/test/a11y.test.tsx && npm run test:e2e`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_cuda_env_shadow.py docs/local-llm.md src/lib/types.ts src/lib/api.ts src/store/config-slice.ts src/views/advanced.tsx src/views/advanced.test.tsx e2e/responsive/coverage.spec.ts e2e/gpu-device-badge.spec.ts src/test/a11y.test.tsx
git commit -m "feat(sidecar,frontend,docs,e2e): .env cutover WARN + banner + e2e/a11y coverage (Plan 2 §2.5)"
```

---

### Task 18: Plan 2 on-box acceptance checklist

- [ ] **Step 1: Run the full battery**

Run: `npm run verify`
Expected: PASS (typecheck + all tests + e2e + build).

- [ ] **Step 2: Append the on-box checklist to this plan's Ship notes**

```markdown
- [ ] Set `tts.qwen.device` to `cuda:1` via the Advanced Configuration picker → the persisted override is `cuda-uuid:<the real GPU-1 UUID>` (inspect `~/.castwright/user-settings.json`), and the row still displays `cuda:1`.
- [ ] Physically swap card order (or simulate via `CUDA_VISIBLE_DEVICES` reorder) → the picker still shows the SAME engine pinned to the SAME physical card by name, now at a different index (the UUID reconcile survives a renumber).
- [ ] Delete the pinned card's driver entry (or set an override to a uuid that no longer exists) → the row shows the `uuid_unresolved` badge, not a silent fallback.
- [ ] Force a Kokoro `cpu_fallback` (e.g. `KOKORO_DEVICE=cuda:9`) → the picker row shows the `cpu_fallback` badge with a clear text label.
- [ ] Select a card with less free VRAM than Qwen's ~6.5GB peak → the footprint pre-warn appears before applying.
- [ ] Set `CUDA_VISIBLE_DEVICES` in `server/.env` → Advanced Configuration surfaces the env-shadow signal; sidecar log shows the startup WARN.
- [ ] Trigger a real code-43 streak via a CARD-SPECIFIC cause (e.g. an absurdly low `SIDECAR_VRAM_FREE_FLOOR_MB` on a busy card) → auto-revert fires, the offending engine's knob is rewritten to a DIFFERENT card or `cpu` (never `auto`); the Advanced Configuration toast shows the "auto-reverted: ..." message (Task 16.5).
- [ ] Trigger a real code-43 streak via a NON-card-specific cause (e.g. an absurdly low `SIDECAR_RESTART_MB` host-RAM ceiling) → TTS is held down (unchanged from Wave 2), but the Advanced Configuration toast now shows the DISTINCT "not tied to a specific GPU card... manual investigation" message — confirms Task 16.5 actually closes the silent-hold gap on a real box, not just in mocked tests.
- [ ] Set `QWEN_DEVICE`/`KOKORO_DEVICE` to two DIFFERENT physical cards via the picker (both persist as `cuda-uuid:` overrides per Task 10) → the VoiceDesign↔Kokoro coupling correctly reflects `shares_device=False` (a design session doesn't block Kokoro synth) — confirms Task 10.5's fix actually resolves the UUID form on-box, not just against the mocked `_enumerate_cuda_devices` in tests.
- [ ] Analyzer row shows the correct live GPU/CPU state and the `docs/local-llm.md` link resolves.
- [ ] `test:a11y` passes on Advanced Configuration with the badges/warnings rendered (not just the empty-state).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-07-02-multi-gpu-wave2-plan2.md
git commit -m "docs(docs): Plan 2 on-box acceptance checklist"
```

---

## Self-Review

**Spec coverage:**
- §W2.1 (ledger) → Task 1. ✓
- §W2.2 (per-card recycle + driver-free floor + ceiling reconcile) → Tasks 2 (sidecar) + 3 (Node). ✓
- §W2.3 (`shares_device` coupling, lock ordering) → Task 4 (coupling) + Task 5 (fixed acquire order at the one proven call site — explicitly NOT an exhaustive sweep of every engine pairing, flagged as a scoped YAGNI decision). ✓ (partial by design)
- §W2.4 (per-card mutex) → Task 5 (the `card_lock` primitive from Task 1, wired at the Qwen design-load site). ✓ (primitive + one site; other same-card pairs deferred, flagged)
- §W2.5 (streak guard, detect+hold+log) → Task 6 (sidecar breadcrumb) + Task 7 (Node streak counter + hold) + Task 16.5 (the operator-visible surfacing the raw spec text doesn't explicitly ask for, but which the "hold" half of "detect+hold+log" is meaningless without — a hold nobody can see is not a hold, it's a silent hang). ✓
- §W2.6 (Node guards, don't cross-charge/cross-evict) → Task 8, now covering BOTH real `withGpuLoad` callers (`ensure-sidecar-loaded.ts` and `routes/qwen-voice.ts` — the second was missing from the original draft, caught by adversarial review). ✓
- §2.1 (UUID identity) → Task 10 + Task 10.5 (closes a gap the same review found: Wave 2's `shares_device`/per-card-mutex machinery, built before Task 10 existed, read raw env directly and would have silently misparsed a UUID-form override as card 0 — Task 10.5 routes both through `_read_device_env` once it exists). ✓
- §2.2 (settings picker: badges, resident-vs-assigned, restart wiring, batching, disabled locked rows, footprint pre-warn) → Task 12 (badges) + Task 13 (plumbing) + Task 14 (footprint). Restart wiring, batching, and disabled-locked-rows are ALREADY satisfied by existing machinery (`selectRestartPending`'s generic any-overridden-restart-sidecar-knob derivation collapses N edits into one banner; `OverrideRow` already passes `disabled={locked}` — confirmed by direct code read, no new task needed). ✓
- §2.3 (auto-revert) → Task 16 (revert when a card is attributable) + Task 16.5 (surface the outcome — reverted or not — to the operator; closes the review's top finding, an unattributable trip previously left TTS held down with zero UI/notification signal). ✓
- §2.4 (analyzer read-only row) → Task 15. ✓
- §2.5 (env-shadow + `.env` cutover) → Task 11 (surfacing) + Task 17 (WARN + docs). ✓
- Plan 2 testing (frontend/server vitest, e2e, a11y) → distributed across Tasks 12-17, consolidated in Task 17's e2e/a11y steps. ✓

**Adversarial review, round 1 (Opus-tier `assumption-checker` pass, 2026-07-02) — three findings, all fixed, user-confirmed as required (not deferrable):**
1. *Most dangerous assumption, confirmed:* a code-43 streak with no attributable card (host-RAM leak, or the pre-Wave-2 device-0 VRAM scalar ceiling) left `runAutoRevert` silently returning `{reverted:[]}` — TTS held down forever with no visible signal. **Fixed:** Task 16's `runAutoRevert` now logs a distinct, actionable error on this path; Task 16.5 surfaces the outcome as an Advanced Configuration toast, polled the same way `sidecar-health.ts` already polls `/health`.
2. *Confirmed via code trace:* `_compute_vd_kokoro_shares_device` (Task 4) and the per-card mutex's index resolution (Task 5) read raw env directly; a `cuda-uuid:<uuid>` override (Task 10's normal picker-write path) would misparse in `_parse_device` — `"cuda-uuid:...".startswith("cuda")` is `True`, the uuid fragment isn't a digit, so the index resolves to `None` and defaults to card 0 — silently defeating BOTH the coupling guard and the per-card mutex the moment Plan 2 ships. **Fixed:** Task 10.5 routes both through `_read_device_env`.
3. *Confirmed via grep:* Task 8's original draft wired `engineOnGpu` through only ONE of the two real `withGpuLoad` callers; `routes/qwen-voice.ts:326` was missing. **Fixed:** added to Task 8.

**Adversarial review, round 2 (Opus-tier `assumption-checker` pass, 2026-07-02, re-verifying round 1's fixes + a fresh sweep) — six findings, all fixed:**
1. *Most dangerous assumption, confirmed:* Task 16.5's `lastAutoRevertOutcome` cache was written "right before each return" — a `runAutoRevert` throw (e.g. `writeConfigOverride` rejecting) never reached a return, leaving the cache stuck at its initial state FOREVER (the supervisor only fires `runAutoRevert` once per trip), and the fire-and-forget trigger in Task 16 Step 6 had no `.catch()`, so a revertible, card-specific trip could be durably mis-reported as "not tied to a specific card — manual investigation" with no way to self-correct. **Fixed:** the cache is now a `'pending'|'reverted'|'unrevertable'|'failed'` state machine; `runAutoRevert`'s ENTIRE body is wrapped in try/catch so every path — including a throw — reaches an assignment; the trigger site gained `.catch()`; a `resetAutoRevertOutcomeForTest()` hook was added (a related finding: the cache had no reset hook, making test order silently load-bearing).
2. *Confirmed via grep:* Task 8's Files list and commit never named `server/src/routes/analysis.ts` — the actual (and only) file Step 2's generic "wire every `detectOllamaDevice()` call site" instruction resolves to. Uncommitted, the whole analyzer-CPU cross-charge optimization would have shipped as dead code (cache permanently `'unknown'`). **Fixed:** named explicitly in Task 8's Files/commit list and Step 2's instructions.
3. *Confirmed via read:* `qwen-voice.test.ts`'s existing `withGpuLoad` mock forwards only the first argument, silently swallowing a second — Task 8's planned "assert `engineDeviceIsGpu('qwen')` was passed" test would have passed trivially without checking anything. **Fixed:** Task 8 now instructs widening the mock FIRST, before writing the new assertion.
4. *Confirmed via trace:* Task 1's `DeviceLedger` renumber-detection depends on torch exposing a real per-card `uuid`; Wave 1's `_sample_card` falls back to an index-derived `f"idx-{idx}"` string when that attribute is absent, which makes a renumber structurally undetectable (the fallback IS the index, so it can never mismatch) — the plan asserted the "never substitutes a renumbered card" guarantee unconditionally. **Fixed:** Task 1's docstring now states the caveat explicitly; Task 9's on-box checklist gained a first-step check for real uuid availability on the target hardware.
5. *Confirmed via read:* Task 9's "analyzer confirmed on CPU" checklist item could fail for a reason unrelated to guard correctness — the cache it depends on is populated only by an actual analysis run, so testing it cold (no analysis ever run) leaves the cache at `'unknown'` (full charge, by design). **Fixed:** reworded to require running an analysis first.
6. *Noted, not a defect:* the Self-Review's "§W2.6 → Task 8 ✓" didn't distinguish that the cross-charge guard only narrows the ANALYZER's cost, not a CPU-pinned TTS engine's own cost — which matches the spec's literal §W2.6 text (it only ever discusses the analyzer's side). **Addressed:** an explicit scope-boundary note added to Task 8 so this isn't silently implied as broader than it is.

Round 2 also confirmed, as NOT bugs (verified, not just asserted): `_read_device_env` returning `None` for an unset env var degrades safely through both `_parse_device` and `shares_device` (both already guard with `or "auto"`); the `qwen-voice.ts` change composes cleanly with `withDesignLock` (orthogonal locks, no shared state); and "two trips racing" is a non-issue since `restart43Trip === null` gates the trip branch to fire at most once per supervisor lifetime.

**Adversarial review, round 3 (Opus-tier `assumption-checker` pass, 2026-07-02, FINAL — loop cap: initial + 2 re-reviews) — one Critical finding plus two secondary implementer snags, all fixed:**
1. *Most dangerous assumption, confirmed — the deepest finding across all three rounds:* the `'reverted'` status never actually restored TTS. `runAutoRevert` wrote config overrides and stopped — no restart call existed anywhere, and NO restart primitive existed to call (`grep` for `restartSidecar` across `server/src/tts/*` found nothing). Worse, the EXISTING pre-plan `POST /api/sidecar/restart` route (`sidecar-health.ts:425-468`, untouched by this plan) *also* couldn't recover a tripped supervisor — it kills `supervisor.current()` and lets `onChildExit` respawn, but a tripped supervisor already has `handle = null` (the process self-exited) and the trip branch returns before the respawn path, so that route 409s too. There was no way back from a trip AT ALL, automatic or manual, across two prior review rounds that both hardened *visibility* without ever checking whether the happy path worked. **Fixed:** Task 7 gains `clearTripAndRespawn()` — the actual missing primitive (resets the trip latch + streak window, calls `spawnOnce()`) — with its own regression test proving a subsequent streak can trip again (the window isn't left poisoned). Task 16's `runAutoRevert` now calls it before returning `status:'reverted'`; a failure there is caught by the same try/catch and correctly demoted to `status:'failed'` rather than a false `'reverted'`. Task 16.5's toast wording corrected from "a sidecar restart is pending" (aspirational, false) to "the sidecar is restarting now" (true as of this fix).
2. *Confirmed via read:* Task 16's own test-writing instruction told the implementer to mock a `restartSidecar` collaborator that doesn't exist anywhere in the codebase — a dead end that would have stalled implementation (or worse, been "fixed" by inventing an ad hoc symbol the plan never scoped). **Fixed:** corrected to mock `getActiveSupervisor().clearTripAndRespawn()`, with explicit test cases proving it's called on success and NOT called on either failure path.
3. *Confirmed via read:* Task 8's `analysis.ts` wiring instruction ("append `setLastKnownAnalyzerDevice(await detectOllamaDevice())` on the same line") was impossible as worded — the real call sits inside a ternary assigned to `const analyzerDevice`, not a bare statement. A literal reading would have doubled the Ollama probe AND poisoned the cache with a GPU/CPU reading even when the analysis ran on a cloud engine. **Fixed:** the instruction now shows the exact surrounding code and the correct edit (`setLastKnownAnalyzerDevice(analyzerDevice)`, using the already-resolved conditional value), with the paired test reworded to assert the conditional behavior instead of "whatever `detectOllamaDevice()` returns."

Round 3 also confirmed, as NOT bugs: `export let lastAutoRevertOutcome`'s live ESM binding is safe (route and mutator share one module, no cross-module hazard); `messageByStatus`'s narrow `Record<'reverted'|'unrevertable'|'failed', string>` type is a compile-time exhaustiveness backstop, not a hazard, if `AutoRevertStatus` ever grows a value; and round 2's `qwen-voice.test.ts` mock-widening and `analysis.ts`-in-commit fixes both still hold against current code. Two documentation-only corrections also landed: `src/lib/types.ts`'s `AutoRevertStatus`/`GpuTripStatus` declaration is now explicitly instructed in Task 16.5 (it was listed in Files but never actually told-to-add in prose), and Task 8's "`!engineOnGpu ||` is redundant, costs nothing" comment was corrected — it's load-bearing for the paired test's `not.toHaveBeenCalled()` assertion, not decoration.

**No further review rounds** — this was round 3 of the loop cap (initial pass + 2 re-reviews = 3 total, per the model-routing skill). A finding this round was still Critical+Contradicted, which would ordinarily re-trigger review, but the cap stops automatic looping here and hands the decision to the user.

**Placeholder scan:** every code step shows complete, real code grounded in files read during plan authoring — no "add appropriate handling" phrasing. Remaining spots explicitly flagged as "verify against current code before writing" (Task 7 Step 1's breadcrumb-path anchor, Task 17 Step 6's route-path check) rather than asserted as certain — this mirrors Wave 1's own plan, which had an equivalent "remaining execution-time reads" list, not a defect.

**Type/interface consistency:** `DeviceLedger.sample()`/`sample_all()`/`card_lock()` (Task 1) are consumed identically in Tasks 2, 5, 6. `_check_per_card_ceilings`'s `{"uuid","idx","reason"}` shape (Task 2) matches what Task 6's breadcrumb writer expects. `_schedule_restart_exit(..., card=)` (Task 2) is the same signature Task 6 extends with the breadcrumb write. `shares_device()` (Task 4) is consumed by `_compute_vd_kokoro_shares_device`, which Task 10.5 updates to feed it RESOLVED values, not raw env — the function's own signature is untouched. `_qwen_configured_card_idx()` (Task 5) is likewise untouched in signature by Task 10.5, only its body. `SidecarSupervisor.tripEvent()` (Task 7) returns exactly the shape Task 16's `runAutoRevert` consumes (`{card, residentEngines} | null`). `readRestartBreadcrumb()`'s return shape (Task 7) matches what Task 6's Python side writes field-for-field. `engineDeviceIsGpu()` (Task 8) is reused by `ensure-sidecar-loaded.ts`, `persona-gpu-plan.ts`, AND `routes/qwen-voice.ts` with the same signature. `staleReason`/`StaleReason` (Tasks 10-13) flow: sidecar → `resolveKnob` (Task 10) → `KnobValueState.staleReason` → frontend `KnobValue.staleReason` (Task 12). `selectRevertTarget()`'s `RevertCandidate{idx,freeMb}` (Task 16) is fed from `getLastKnownGpuDevices()`, whose shape-widen (from Task 10's `{uuid,idx}` to add `freeMb`) is explicitly flagged in Task 16 Step 4. `AutoRevertResult{status,reverted}` (Task 16, revised round 2 from a boolean `revertible` to a 4-state machine) is the exact shape Task 16.5's `/api/gpu/trip-status` route AND its frontend `messageByStatus` lookup both key on — three distinct toast messages for `'reverted'|'unrevertable'|'failed'`, none for `'pending'`. `SidecarSupervisor.clearTripAndRespawn()` (added Task 7, round 3) returns `Promise<void>` and is called from exactly one place — Task 16's `runAutoRevert` success path — with no other consumer in this plan; its own test (Task 7 Step 4.5) proves the trip window is genuinely reset, not just the visible `tripEvent()` flag, by driving a second streak through to a second trip afterward.

**Known scoped gaps (deliberate, not oversights):**
- Per-card mutex (Task 5) wired at ONE call site (Qwen design-load), not every theoretically-possible same-card engine pair — YAGNI per Round 5's simplicity-first framing; flagged inline in Task 5.
- Auto-revert's card-freeVRAM data depends on the LAST successful `/api/gpu/devices` poll (Task 16), same staleness tolerance the existing `vram-state.ts` cache already accepts — not a new class of risk.
- The `.env` cutover (Task 17) is a documented MANUAL step, per Round 5's decision — no code strips a user's `.env` automatically.
- A non-card-specific streak (`'unrevertable'` status) still leaves TTS held down with no automatic recovery — this is now VISIBLE (toast + `/api/gpu/trip-status`) rather than silent, but recovery still requires a human to read the alert and manually restart the server. Auto-recovering from a host-RAM leak is out of scope (a different problem than device placement).
- `costForEngine('qwen'|'coqui'|'kokoro')` is NOT narrowed for a CPU-pinned engine's own cost (only the analyzer's cost is) — matches the spec's literal §W2.6 scope, noted explicitly in Task 8 rather than left implicit.
- `DeviceLedger`'s renumber-detection (Task 1) is a no-op on hardware/torch builds that don't expose `get_device_properties(idx).uuid` — Task 9's on-box checklist now checks for this explicitly rather than assuming it.

---

## Ship notes

*(Filled in per-PR as Wave 2 and Plan 2 each merge — see Tasks 9 and 18 for the on-box checklists.)*

### Wave 2 — status: NOT YET SHIPPED

**On-box acceptance checklist:**

- [ ] **First, confirm torch exposes real per-card UUIDs on this box**: `python -c "import torch; print(torch.cuda.get_device_properties(0).uuid)"` in the sidecar venv → prints a real UUID, not an `AttributeError`. If it errors, `_sample_card`'s `idx-N` synthetic fallback is in effect and `DeviceLedger`'s renumber-detection (Task 1) is a no-op on this box — note this explicitly in the Ship notes rather than silently assuming the guarantee holds (a round-2 review finding).
- [ ] `SIDECAR_VRAM_FREE_FLOOR_MB=1024` (default) — starve a card to <1024MB free (load something else onto it manually / reduce via a smaller test card) → sidecar self-exits (code 43), `/health` gpus[] showed the breach before exit.
- [ ] `QWEN_DEVICE=cuda:0 KOKORO_DEVICE=cuda:1` (different cards) → a VoiceDesign session runs WHILE a Kokoro chapter synthesizes concurrently, no blocking (shares_device=False path).
- [ ] `QWEN_DEVICE=cuda:0 KOKORO_DEVICE=cuda:0` (same card, default) → VoiceDesign blocks new Kokoro synths until it completes (shares_device=True path, unchanged from Wave 1).
- [ ] Force 3 code-43 exits within 10 minutes via a CARD-SPECIFIC trigger (e.g. temporarily set `SIDECAR_VRAM_FREE_FLOOR_MB` absurdly high) → server log shows the streak-trip warning; the sidecar stops respawning; `supervisor.tripEvent()` shows the right card + resident engines.
- [ ] **Force 3 code-43 exits within 10 minutes via a NON-card-specific trigger** (e.g. temporarily set `SIDECAR_RESTART_MB` absurdly low so the HOST-RAM ceiling trips 3× in a row) → the streak still trips (Task 7 counts any code-43, not just per-card ones); Task 16's `runAutoRevert` logs the distinct "tripped WITHOUT a specific card... requires MANUAL investigation" error rather than silently returning `{reverted:[]}`; TTS stays held down as expected, but this is now VISIBLE (Task 16.5's `/api/gpu/trip-status` reports `status:'unrevertable'`).
- [ ] Analyzer confirmed on CPU (`ANALYZER=local` with an Ollama CPU-only install) — **run at least one analysis first** (the cache in `analyzer-device-state.ts` is only populated at the one real `detectOllamaDevice()` call site, `routes/analysis.ts`; it stays `'unknown'`/full-charge before that, by design — a round-2 review caught this checklist item as untested-until-populated) → a concurrent Qwen GPU synth is NOT serialized behind the analyzer (costForEngine('analyzer') returns 0).
- [ ] Analyzer confirmed on GPU → existing serialization behaviour is UNCHANGED (regression check against pre-Wave-2 behaviour).
- [ ] `COQUI_DEVICE=cpu` while the analyzer holds the GPU → the Coqui load runs immediately, no eviction wait (engineOnGpu=false path in withGpuLoad).
- [ ] Qwen voice-design (`routes/qwen-voice.ts`'s `designQwenVoiceForCharacter`) while `tts.qwen.device=cpu` → the design's `withGpuLoad` call runs immediately too (the second `withGpuLoad` call site Task 8 wires, not just `ensure-sidecar-loaded.ts`'s).

### Plan 2 — status: NOT YET SHIPPED (gated on Wave 2)
