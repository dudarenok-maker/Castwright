"""#2094 review — the ASR-specific free-memory-DELTA measurement
`PlacementController.reservation()` uses for a COLD `asr` load. faster-whisper's
CTranslate2 backend allocates its weights entirely outside torch's caching
allocator, so a cold `_observed_mb` (`torch.cuda.max_memory_allocated`)
reading is whatever residual torch activity happened to be co-resident — a
plausible source of the contaminated 3707 MB `asr` figure #2094 itself
reported.

#2682 found the device-wide delta too noisy to ever return a positive
`asr.warm` sample and parked RESIDENT forwards on the torch-allocator path;
#2930/#3012 then proved that path structurally reads 0 for a
CTranslate2-backed forward — so #3036/#3265 moved `asr.warm` onto a THIRD
technique: an NVML own-process delta (`_own_process_used_mb` read
before/after a resident forward). This module covers the COLD `asr`
device-wide delta AND the WARM `asr.warm` own-process delta — see
`test_asr_warm_measurement_uses_the_nvml_own_process_delta` for the warm path.

These drive `reservation()` end-to-end for `engine="asr"` with
`PlacementController._device_free_mb` (cold) or `_load_pynvml` (warm)
monkeypatched to a scripted before/after sequence — no real CUDA needed —
and assert on what reaches `footprints.record()`."""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Optional

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

_RAN = object()


def run_case(coro):
    assert asyncio.run(coro) is _RAN, "async test body did not run to completion"


def dev(kind="cuda", index=0, total=8192, free=8000):
    return {"kind": kind, "index": index, "label": "g", "totalMb": total, "freeMb": free}


class _RecordingFootprints:
    """Real seed lookup (so the "asr" cold seed used by the warm-ceiling
    guard is the genuine 400 MB, not a stub) but records every `.record()`
    call so tests can assert on what was actually attributed to ASR."""

    def __init__(self, peak: int) -> None:
        self._peak = peak
        self.records: list[tuple[str, Optional[str], Optional[dict], int, bool]] = []

    def peak_mb(self, engine, model, cfg, resident=False):  # noqa: D102 - test double
        return self._peak

    def record(self, engine, model, cfg, observed_mb, resident=False):  # noqa: D102
        self.records.append((engine, model, cfg, observed_mb, resident))


def make_pc(devices, peak=400, resident=None):
    fp = _RecordingFootprints(peak)
    pc = main.PlacementController(
        probe=lambda: devices,
        footprints=fp,
        ledger=main.ReservationLedger(),
        reserve_mb=lambda: 200,
        idle_evict_steps=lambda dk, eng: [],
        is_resident=resident or (lambda e: None),
    )
    return pc, fp


def _patch_free_mb(monkeypatch, sequence: list[Optional[int]]) -> None:
    """`_device_free_mb` is called twice per reservation (before, in
    `_resolve_admission`; after, in `reservation()`'s finally) — pop the
    scripted sequence in call order.

    Also defaults `_load_pynvml` (#2094 per-process attribution) to a fake
    `pynvml` reporting only this process's own PID on the device, so every
    test in this module that isn't specifically exercising the NVML guard
    keeps testing Guard 1 (ledger) / Guard 2 (warm ceiling) in isolation via
    the REAL `_foreign_pid_holds_device` body, exactly as before that guard
    existed. Patched at `_load_pynvml` (not `_foreign_pid_holds_device`
    itself) so a test exercising the NVML guard can override just the
    `pynvml` stand-in via its own later `monkeypatch.setattr(main,
    "_load_pynvml", ...)` call and still run through the real method."""
    calls = list(sequence)

    def fake(device_key):
        assert calls, "fake _device_free_mb called more times than scripted"
        return calls.pop(0)

    monkeypatch.setattr(main.PlacementController, "_device_free_mb", staticmethod(fake))
    monkeypatch.setattr(main, "_load_pynvml", lambda: _FakePynvml([os.getpid()]))


class _FakeProc:
    """`used_mb` (#3036/#3265) mirrors the real struct's second documented
    field, `usedGpuMemory` — BYTES in the real driver, None when the driver
    declines to report per-process usage (a documented Windows/WDDM case the
    warm tests need to script). Pre-#3036 tests never read it."""

    def __init__(self, pid: int, used_mb: Optional[int] = None) -> None:
        self.pid = pid
        self.usedGpuMemory = None if used_mb is None else used_mb * 1_048_576


class _FakePynvml:
    """A scripted stand-in for the real `pynvml` module, injected via
    `main._load_pynvml` so `_foreign_pid_holds_device`'s and
    `_own_process_used_mb`'s real bodies (index parsing, handle lookup,
    process-list comparison, shutdown) run end-to-end without a real
    NVML/driver present. `memories` (#3036) is a pid->used-MB map applied to
    every returned entry; `memory_sequence` scripts ONE used-MB value per
    call — the before/after pair a warm `reservation()` takes — and once the
    script is exhausted the OWN pid vanishes from the list entirely (the
    WDDM half-measurement edge case)."""

    def __init__(
        self,
        pids: list[int],
        raise_on_init: bool = False,
        memories: Optional[dict[int, int]] = None,
        memory_sequence: Optional[list[int]] = None,
    ) -> None:
        self._pids = pids
        self._raise_on_init = raise_on_init
        self._memories = memories
        self._memory_sequence = memory_sequence
        self.shutdown_called = False

    def nvmlInit(self):  # noqa: N802 - matches real pynvml's naming
        if self._raise_on_init:
            raise RuntimeError("cuda driver can't be loaded")

    def nvmlDeviceGetHandleByIndex(self, index):  # noqa: N802
        return f"handle-{index}"

    def nvmlDeviceGetComputeRunningProcesses(self, handle):  # noqa: N802
        if self._memory_sequence is not None:
            if not self._memory_sequence:
                return []  # own PID no longer in the list at all
            used_mb = self._memory_sequence.pop(0)
            return [_FakeProc(pid, used_mb) for pid in self._pids]
        return [_FakeProc(pid, (self._memories or {}).get(pid)) for pid in self._pids]

    def nvmlShutdown(self):  # noqa: N802
        self.shutdown_called = True


def test_asr_cold_reservation_records_the_free_memory_delta(monkeypatch) -> None:
    """Cold (not resident): before=5000, after=4900 -> a 100 MB delta is
    exactly what a genuine cold-load observation should look like, and
    nothing here caps it.

    Mutation that must fail it — breaks the PRODUCER: revert `reservation()`'s
    `observed_mb = asr_observed_mb if (engine == "asr" and not resident) else
    self._observed_mb(...)` back to unconditionally calling
    `self._observed_mb(device_key)` (the torch-allocator path) — with no real
    torch/CUDA, that returns 0 and this test's delta assertion fails.
    """
    devices = [dev()]
    pc, fp = make_pc(devices, peak=400, resident=lambda e: None)
    _patch_free_mb(monkeypatch, [5000, 4900])

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False) as adm:
            assert "device" in adm
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 100, False)]


def test_asr_reservation_discards_when_another_engine_holds_the_device(monkeypatch) -> None:
    """A concurrent Coqui reservation on the SAME device during the ASR op's
    window is exactly the contamination #2094 flagged (a concurrent render
    inflating the reading) — `reservation()` must discard the measurement
    (record 0) rather than attribute someone else's allocation to ASR.

    Mutation that must fail it — breaks the PRODUCER: drop the
    `other_engines = self.ledger.engines_holding(device_key) - {engine}` check
    (i.e. always treat the reading as trustworthy). The recorded observation
    would then be 500 (the real delta), not 0.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=400, resident=lambda e: None)
    _patch_free_mb(monkeypatch, [10000, 9500])  # a real 500 MB delta

    async def body():
        # A concurrent op on the SAME device, held across the ASR op's ENTIRE
        # window — including the point where `reservation()`'s own `finally`
        # checks `engines_holding` — simulates a real Coqui render sharing
        # the card. Released only AFTER the ASR reservation has exited, so
        # the contamination is still present at measurement time.
        coqui_token = pc.ledger.hold(devices[0]["kind"] + ":0", 3000, "coqui")
        try:
            async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
                pass
        finally:
            pc.ledger.release(coqui_token)
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, False)]


def test_asr_warm_measurement_uses_the_nvml_own_process_delta(monkeypatch) -> None:
    """RESIDENT ASR (warm) — #3036/#3265: `asr.warm` measures neither the
    torch-allocator peak (#2930/#3012: a CTranslate2 forward reads
    structurally 0 there) nor the device-wide free-memory delta (#2682:
    indistinguishable from card noise). `reservation()` now pairs two
    `_own_process_used_mb` NVML OWN-PROCESS readings — the before-reading
    taken in `_resolve_admission` alongside the residency snapshot, the
    after-reading in the `finally` before the hold releases — and records
    their delta: 2048 MB -> 2148 MB records 100. `_device_free_mb` stays
    cold-path-only.

    Mutation that must fail it — delete the `elif engine == "asr" and
    resident:` branch from `reservation()`'s three-way `observed_mb` choice
    (the pre-#3036 fall-through to `self._observed_mb(device_key)` for the
    warm case). The stubbed 77 would then be recorded, not the NVML 100.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")

    def fail_if_called(device_key):
        raise AssertionError("_device_free_mb must not be called for a resident ASR forward")

    monkeypatch.setattr(main.PlacementController, "_device_free_mb", staticmethod(fail_if_called))
    # Stubbed (rather than relying on the no-CUDA-in-CI 0 every other test in
    # this module uses) so this test can tell "the NVML delta was recorded"
    # apart from "fell through to the torch-allocator path" — the latter
    # reads 77 here, the former 100.
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    # ONE fake instance: `_load_pynvml` is called by both the before- and the
    # after-reading, and the scripted sequence lives on the instance.
    fake = _FakePynvml([os.getpid()], memory_sequence=[2048, 2148])
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 100, True)]


def test_asr_warm_reservation_discards_when_the_after_reading_fails(monkeypatch) -> None:
    """Half a measurement is no measurement: the before-reading succeeds
    (2048 MB) but the after-reading's process list no longer contains our
    own PID at all — the WDDM edge case #3265 documents — so the sample is
    discarded (recorded 0, `record()`'s `<= 0` guard drops it) rather than
    trusted against a delta computed from nothing.

    Mutation that must fail it — delete the `if warm_after_mb is not None`
    guard in `reservation()`'s warm block: the arithmetic on `None` raises
    inside the `finally` of every resident ASR op, breaking the
    never-crash contract (this test fails with that TypeError — which is
    precisely the point).
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    fake = _FakePynvml([os.getpid()], memory_sequence=[2048])
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, True)]


def test_asr_warm_reservation_does_not_double_guard_non_positive_deltas(monkeypatch) -> None:
    """#3265: a non-positive delta is the job of `record()`'s existing
    `observed_mb <= 0` guard — `reservation()` must NOT invent a second one.
    A negative raw delta (2148 -> 2048, e.g. unrelated own-process
    allocations freed between the readings) reaches `record()` verbatim,
    where the single owner of that rule drops it (the real table's dropping
    is asserted in test_footprints.py).

    Mutation that must fail it — add a `warm_after_mb > warm_before_mb`
    guard to `reservation()`'s warm block: `record()` would see 0 via the
    `or 0` instead of -100, silently duplicating the drop rule in a place
    where it can drift from `record()`'s.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    fake = _FakePynvml([os.getpid()], memory_sequence=[2148, 2048])
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, -100, True)]


def test_asr_cold_measurement_is_not_capped(monkeypatch) -> None:
    """#2682 removed the implausible-delta "warm ceiling" entirely — it only
    ever applied to the RESIDENT case, which no longer takes this
    (`_device_free_mb`-delta) path at all (see
    `test_asr_warm_measurement_uses_the_torch_allocator_path`). A cold
    observation — even an unusually large one — is NOT capped here;
    FootprintTable's own p95 windowing is what tames a cold-side outlier,
    matching every other key's "up OR down" learning philosophy.

    Mutation that must fail it — breaks the PRODUCER: reintroduce a ceiling
    that discards a large cold delta. A cold 3707 MB delta would then be
    discarded (recorded as 0) instead of kept.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=400, resident=lambda e: None)
    _patch_free_mb(monkeypatch, [10000, 6293])  # a 3707 MB delta, but COLD (resident=None)

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 3707, False)]


def test_non_asr_engine_still_uses_the_torch_allocator_path(monkeypatch) -> None:
    """Scope check (review: "fix the measurement for THIS engine") — a
    non-ASR engine must never route through `_device_free_mb`; it keeps the
    existing `_observed_mb` (torch-allocator) path unchanged. Asserts
    `_device_free_mb` is never even called for a Coqui reservation."""
    devices = [dev()]
    pc, fp = make_pc(devices, peak=3584, resident=lambda e: None)

    calls: list[str] = []

    def fail_if_called(device_key):
        calls.append(device_key)
        raise AssertionError("_device_free_mb must not be called for a non-ASR engine")

    monkeypatch.setattr(main.PlacementController, "_device_free_mb", staticmethod(fail_if_called))

    async def body():
        async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True):
            pass
        return _RAN

    run_case(body())

    assert calls == []
    # No real torch/CUDA in this test env — `_observed_mb` guards to 0, same
    # as every other placement test that doesn't stub torch.
    assert fp.records == [("coqui", None, {}, 0, False)]


def test_admit_and_reservation_agree_on_needed_mb_for_a_resident_engine() -> None:
    """#2094 review R11 — `admit()` is the ADVISORY twin of `reservation()`'s
    binding decision; both must consult residency identically. Before the
    fix, `admit()` called `peak_mb(engine, model, cfg)` with NO `resident`
    argument, so a starved resident-ASR `noCapacity` from `admit()` would
    report the cold 400 MB figure while `reservation()` — the path that
    actually runs — reports the resident `asr.warm` figure (128 MB seed).
    They must report the SAME `neededMb` for the identical inputs.

    Mutation that must fail it — breaks the PRODUCER: revert `admit()`'s
    `peak_mb(engine, model, cfg, resident is not None)` back to
    `peak_mb(engine, model, cfg)`. `admit()`'s `neededMb` would then read 400
    while `reservation()`'s reads 128.
    """
    tiny_free = [dev(total=8000, free=50)]  # too small for either figure to fit
    pc, _fp = make_pc(tiny_free, peak=main.SEED_FOOTPRINTS_MB["asr"], resident=lambda e: "cuda:0")
    # Real FootprintTable (not the peak-stubbing test double) so the
    # cold-vs-warm SEED split under test is the genuine one, not a fixed stub.
    pc.footprints = main.FootprintTable()

    async def body():
        adm = await pc.admit("asr", None, {}, cpu_capable=False, heavy=False)
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False) as res_adm:
            assert "noCapacity" in res_adm
            assert adm["noCapacity"]["neededMb"] == res_adm["noCapacity"]["neededMb"]
            assert adm["noCapacity"]["neededMb"] == main.SEED_FOOTPRINTS_MB["asr.warm"]
        return _RAN

    run_case(body())


# --- #2094 per-process attribution (NVML) ------------------------------
#
# The two guards above narrow but do not eliminate #2094's contamination
# question: Guard 1 (ledger.engines_holding) only knows about SIDECAR-
# tracked reservations, and Guard 2 (the implausible-delta ceiling) is
# WARM-only, so a COLD reading had no protection at all against a foreign,
# non-sidecar process on the same card (the documented failure mode: a
# concurrent worktree's pytest suite holding VRAM). These tests cover
# `PlacementController._foreign_pid_holds_device` directly (unit level) and
# `reservation()`'s wiring of it (integration level, through the real
# method body via a fake `pynvml` injected at `main._load_pynvml`).


def test_foreign_pid_holds_device_returns_none_for_a_non_cuda_device_key(monkeypatch) -> None:
    """NVML covers NVIDIA only -- a rocm: (or missing) device_key can't be
    attributed via this path and must report "can't determine", not "clean".

    A fake pynvml that WOULD report a clean "only self" result if reached is
    stubbed in deliberately -- if the guard below the docstring were bypassed,
    the "rocm:0" case would resolve to False (not None) via this fake, so
    the assertion actually exercises the guard rather than coincidentally
    passing because pynvml happens to be absent from this venv.

    Mutation that must fail it -- breaks the PRODUCER: drop the
    device_key.startswith("cuda:") guard. A "rocm:0" key would then fall
    through to the (fake) pynvml call and report False instead of None.
    """
    monkeypatch.setattr(main, "_load_pynvml", lambda: _FakePynvml([os.getpid()]))
    assert main.PlacementController._foreign_pid_holds_device("rocm:0") is None
    assert main.PlacementController._foreign_pid_holds_device(None) is None


def test_foreign_pid_holds_device_returns_none_when_pynvml_is_unavailable(monkeypatch) -> None:
    """Fail-conservative: pynvml not installed (_load_pynvml returns None)
    must report "can't determine", never "clean".

    Mutation that must fail it -- breaks the PRODUCER: return False instead
    of None from the "pynvml is None" branch. A box with no NVML installed
    would then read as a POSITIVE clean confirmation instead of unattributable.
    """
    monkeypatch.setattr(main, "_load_pynvml", lambda: None)
    assert main.PlacementController._foreign_pid_holds_device("cuda:0") is None


def test_foreign_pid_holds_device_returns_false_when_only_self_is_present(monkeypatch) -> None:
    """The positive-confirmation path: NVML enumerates exactly this
    process's own PID on the device -- genuinely attributable, so False
    ("no foreign PID"), not None/True.

    Mutation that must fail it -- breaks the PRODUCER: compare against a
    hardcoded/wrong pid (e.g. drop own_pid = os.getpid() and compare
    against 0) instead of the real process's own pid. This process's own PID
    would then read as "foreign" and the assertion below would see True.
    """
    fake = _FakePynvml([os.getpid()])
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._foreign_pid_holds_device("cuda:0") is False
    assert fake.shutdown_called, "nvmlShutdown must run even on the happy path"


def test_foreign_pid_holds_device_returns_false_when_the_process_list_is_empty(monkeypatch) -> None:
    """No compute processes at all on the device is also a clean reading --
    any() over an empty list is False, not an error."""
    fake = _FakePynvml([])
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._foreign_pid_holds_device("cuda:0") is False


def test_foreign_pid_holds_device_returns_true_when_a_foreign_pid_is_present(monkeypatch) -> None:
    """A PID other than this process holding memory on the device is exactly
    the #2094 failure mode -- must report True (discard).

    Mutation that must fail it -- breaks the PRODUCER: use all(...) instead
    of any(...) (or invert the comparison) when scanning the process list.
    A foreign PID alongside this process's own would then read as False.
    """
    fake = _FakePynvml([os.getpid(), os.getpid() + 999])
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._foreign_pid_holds_device("cuda:0") is True


def test_foreign_pid_holds_device_returns_none_on_an_nvml_error(monkeypatch) -> None:
    """An NVML-level failure (e.g. nvmlInit raising because the driver
    can't be loaded) must report "can't determine", not crash the caller and
    not report "clean".

    Mutation that must fail it -- breaks the PRODUCER: drop the try/except
    around the NVML calls. nvmlInit's RuntimeError would then propagate
    out of _foreign_pid_holds_device instead of being swallowed into None.
    """
    fake = _FakePynvml([], raise_on_init=True)
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._foreign_pid_holds_device("cuda:0") is None


def test_asr_cold_reservation_discards_when_a_foreign_pid_is_present(monkeypatch) -> None:
    """End-to-end: a genuine 100 MB cold delta (the same shape as
    test_asr_cold_reservation_records_the_free_memory_delta) must still be
    discarded when NVML reports a foreign PID on the device -- the gap #2094
    flagged as unprotected for the COLD bucket specifically.

    Mutation that must fail it -- breaks the PRODUCER: drop the
    "not foreign_before and not foreign_after" clause from reservation()'s
    ASR guard. The 100 MB delta would then be recorded despite the foreign
    PID, reproducing #2094's contamination shape.
    """
    devices = [dev()]
    pc, fp = make_pc(devices, peak=400, resident=lambda e: None)
    _patch_free_mb(monkeypatch, [5000, 4900])  # a real 100 MB delta
    fake = _FakePynvml([os.getpid(), os.getpid() + 999])  # a foreign PID
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    # _patch_free_mb's default "only self" stub must be overridden by the
    # line above (later setattr wins) -- this asserts that ordering holds.
    assert main.PlacementController._foreign_pid_holds_device("cuda:0") is True

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, False)]


def test_asr_cold_reservation_records_when_only_self_holds_the_device(monkeypatch) -> None:
    """Positive confirmation: NVML reports every process on the device is
    this one -- the genuine 100 MB cold delta is attributable and kept."""
    devices = [dev()]
    pc, fp = make_pc(devices, peak=400, resident=lambda e: None)
    _patch_free_mb(monkeypatch, [5000, 4900])  # a real 100 MB delta
    fake = _FakePynvml([os.getpid()])
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 100, False)]


def test_asr_cold_reservation_discards_when_nvml_is_unavailable(monkeypatch) -> None:
    """Fail-conservative end-to-end: pynvml not installed must discard a
    genuine 100 MB cold delta rather than trust an unattributable reading.

    Mutation that must fail it -- breaks the PRODUCER: change foreign_before/
    foreign_after's "is not False" comparison to "is True" (treating None --
    "couldn't determine" -- as trustworthy instead of untrustworthy). The
    100 MB delta would then be recorded despite NVML being unavailable.
    """
    devices = [dev()]
    pc, fp = make_pc(devices, peak=400, resident=lambda e: None)
    _patch_free_mb(monkeypatch, [5000, 4900])  # a real 100 MB delta
    monkeypatch.setattr(main, "_load_pynvml", lambda: None)  # NVML unavailable

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, False)]


# ---------------------------------------------------------------------------
# #3036/#3265 — direct tests of `_own_process_used_mb`'s None contract (the
# warm before/after producer). Every failure mode MUST yield None, never 0:
# `record()`'s `<= 0` guard cannot tell "own process holds nothing" from
# "could not measure" if failures also read 0 — the same reasoning as
# `_device_free_mb`'s None contract.
# ---------------------------------------------------------------------------


def test_own_process_used_mb_returns_none_for_a_non_cuda_device_key(monkeypatch) -> None:
    """NVML covers NVIDIA only — same guard shape as
    `_foreign_pid_holds_device` above — and it must fire BEFORE `_load_pynvml`
    is even reached.

    Mutation that must fail it — loosen the guard to merely
    `if not device_key:` so `rocm:` falls through to the int(split) parser.
    """

    def explode():
        raise AssertionError("_load_pynvml must not be reached for a non-CUDA device_key")

    monkeypatch.setattr(main, "_load_pynvml", explode)
    assert main.PlacementController._own_process_used_mb("rocm:0") is None
    assert main.PlacementController._own_process_used_mb(None) is None


def test_own_process_used_mb_returns_none_when_pynvml_is_unavailable(monkeypatch) -> None:
    """pynvml not importable -> None, not 0 (see the block comment above).

    Mutation that must fail it — turn the `pynvml is None` guard's
    `return None` into `return 0`.
    """
    monkeypatch.setattr(main, "_load_pynvml", lambda: None)
    assert main.PlacementController._own_process_used_mb("cuda:0") is None


def test_own_process_used_mb_returns_none_when_own_pid_is_absent(monkeypatch) -> None:
    """Our own PID missing from the device's process list (WDDM's lazy
    per-process accounting simply never surfaced it) -> None, not a
    pretend-measurement 0. A FOREIGN entry with real memory on the list
    must not be mistaken for ours either.

    Mutation that must fail it — replace the loop fall-through's
    `return None` with `return 0`.
    """
    foreign = os.getpid() + 999
    fake = _FakePynvml([foreign], memories={foreign: 500})
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._own_process_used_mb("cuda:0") is None


def test_own_process_used_mb_returns_mb_for_an_own_entry(monkeypatch) -> None:
    """A real entry: 512 MB of `usedGpuMemory` (BYTES from the driver) comes
    back as 512, shutdown runs, and a foreign PID co-resident on the device
    does not perturb the reading — per-process accounting is immune to
    exactly the contamination that forces the cold path's foreign-PID
    discard, which is the whole point of this technique (#3036).

    Mutation that must fail it — return bytes instead of MB (drop the
    `// 1_048_576`), or return the FIRST list entry instead of the
    `pid == os.getpid()` one (the scripted list puts the foreign 9999-MB
    entry first for that reason).
    """
    foreign = os.getpid() + 999
    fake = _FakePynvml([foreign, os.getpid()], memories={foreign: 9999, os.getpid(): 512})
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._own_process_used_mb("cuda:0") == 512
    assert fake.shutdown_called


def test_own_process_used_mb_returns_none_when_used_gpu_memory_is_zero(monkeypatch) -> None:
    """A falsy (0/None) `usedGpuMemory` cannot be distinguished from "the
    driver declined to report", so it must route to None — never 0.

    Mutation that must fail it — drop the `if not used: return None` branch
    so the falsy reading flows straight into the MB conversion (0 then
    masquerades as a measurement).
    """
    fake = _FakePynvml([os.getpid()], memories={os.getpid(): 0})
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._own_process_used_mb("cuda:0") is None


def test_own_process_used_mb_swallows_a_missing_used_gpu_memory_attribute(monkeypatch) -> None:
    """Some pynvml versions/paths omit the `usedGpuMemory` attribute
    entirely; a weird driver response must degrade to None, not crash a
    resident ASR op's measurement — the never-raises half of the contract
    (`getattr` + the broad except).

    Mutation that must fail it — break the never-raises shape (remove the
    broad `except Exception: return None`): the AttributeError/TypeError
    from the direct-attribute and None-arith variants escapes instead of
    degrading to None.
    """
    fake = _FakePynvml([os.getpid()])
    entry = _FakeProc(os.getpid(), 512)
    del entry.usedGpuMemory  # attribute absent, not merely falsy
    fake.nvmlDeviceGetComputeRunningProcesses = lambda handle: [entry]
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._own_process_used_mb("cuda:0") is None


def test_own_process_used_mb_swallows_nvml_init_failure(monkeypatch) -> None:
    """NVML entirely unavailable (driver not loaded — same injection the
    `_foreign_pid_holds_device` error test uses) -> None, never raises.

    Mutation that must fail it — let `nvmlInit`'s exception escape instead
    of landing in the broad except.
    """
    fake = _FakePynvml([], raise_on_init=True)
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)
    assert main.PlacementController._own_process_used_mb("cuda:0") is None
