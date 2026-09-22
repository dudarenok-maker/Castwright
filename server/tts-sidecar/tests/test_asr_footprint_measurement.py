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
before/after a resident forward). #3265's on-box run then proved THAT dead
on this box (WDDM reports `usedGpuMemory=None` for our own PID, so every warm
sample was discarded) — and #3266 brought `asr.warm` BACK to the device-wide
delta, this time behind the full cold-path guard set (foreign-PID
attribution + concurrent-reservation ledger), which #2094's original warm
attempt lacked. This module covers the COLD `asr` device-wide delta AND the
WARM `asr.warm` device-wide delta — see
`test_asr_warm_measurement_uses_the_device_free_delta` for the warm path.

These drive `reservation()` end-to-end for `engine="asr"` with
`PlacementController._device_free_mb` (cold and warm, #3266) or
`_load_pynvml` (the foreign-PID guard, and the retired-but-still-tested
`_own_process_used_mb` unit contract below) monkeypatched to a scripted
before/after sequence — no real CUDA needed — and assert on what reaches
`footprints.record()`."""
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
    declined to report per-process usage (a documented Windows/WDDM case).
    Pre-#3036 tests never read it."""

    def __init__(self, pid: int, used_mb: Optional[int] = None) -> None:
        self.pid = pid
        self.usedGpuMemory = None if used_mb is None else used_mb * 1_048_576


class _FakePynvml:
    """A scripted stand-in for the real `pynvml` module, injected via
    `main._load_pynvml` so `_foreign_pid_holds_device`'s and
    `_own_process_used_mb`'s real bodies (index parsing, handle lookup,
    process-list comparison, shutdown) run end-to-end without a real
    NVML/driver present. `memories` (#3036) is a pid->used-MB map applied to
    every returned entry; `memory_sequence` (#3036/#3265) scripted ONE
    used-MB value per call for child 1's warm own-process before/after pair —
    #3266 moved the warm path back to `_device_free_mb`, so no test drives it
    any more; it stays so the fake keeps the shape the #3265-era tests
    exercised."""

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


def test_asr_warm_measurement_uses_the_device_free_delta(monkeypatch) -> None:
    """RESIDENT ASR (warm) — #3266: `asr.warm` measures neither the
    torch-allocator peak (#2930/#3012: a CTranslate2 forward reads
    structurally 0 there) nor child 1's NVML own-process delta (#3265: WDDM
    reports `usedGpuMemory=None` for our own PID on this box, so every sample
    was discarded). `reservation()` now pairs two `_device_free_mb`
    device-wide readings — the before-reading taken in `_resolve_admission`
    alongside the residency snapshot, the after-reading in the `finally`
    before the hold releases — and records their delta: free 2048 MB -> 1948
    MB records 100. `_own_process_used_mb` must NOT be called from this path
    any more; it is stubbed to raise so a regression to child 1's technique
    fails loudly rather than silently reading None.

    Mutation that must fail it — revert this branch to child 1's NVML
    own-process pairing (`warm_after_mb - warm_before_mb` from
    `_own_process_used_mb`). The stubbed method raises AssertionError and the
    test fails before the delta is even compared.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")

    def fail_if_called(device_key):
        raise AssertionError(
            "_own_process_used_mb must not be called for a resident ASR forward (#3266)"
        )

    monkeypatch.setattr(
        main.PlacementController, "_own_process_used_mb", staticmethod(fail_if_called)
    )
    # Stubbed (rather than relying on the no-CUDA-in-CI 0 every other test in
    # this module uses) so this test can tell "the device-wide delta was
    # recorded" apart from "fell through to the torch-allocator path" — the
    # latter reads 77 here, the former 100.
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    # before=2048 free, after=1948 free -> the forward took 100 MB.
    _patch_free_mb(monkeypatch, [2048, 1948])

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 100, True)]


def test_asr_warm_reservation_discards_when_the_after_reading_fails(monkeypatch) -> None:
    """Half a measurement is no measurement: the before-reading succeeds
    (2048 MB free) but the after-reading returns None (`_device_free_mb`
    swallows any pynvml error into None, mirroring the cold path's contract)
    — the sample is discarded (recorded 0, `record()`'s `<= 0` guard drops
    it) rather than trusted against a delta computed from nothing.

    Mutation that must fail it — delete the `warm_after_mb is not None`
    clause from the guard: the arithmetic on `None` raises inside the
    `finally` of every resident ASR op, breaking the never-crash contract
    (this test fails with that TypeError — which is precisely the point).
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    _patch_free_mb(monkeypatch, [2048, None])  # after-reading fails

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, True)]


def test_asr_warm_reservation_discards_when_a_foreign_pid_is_present(monkeypatch) -> None:
    """#3266's whole theory is that the device-wide warm delta (#2094,
    abandoned by #2682) failed from CONTAMINATION, not driver noise — so the
    guard that was missing back then must now be live: NVML reports a foreign
    PID on the device and a genuine 100 MB delta is discarded. This is the
    cold path's `test_asr_cold_reservation_discards_when_a_foreign_pid_is_
    present` mirrored onto the warm branch.

    Mutation that must fail it — drop the `not foreign_before and not
    warm_foreign_after` clauses from the warm guard: the 100 MB delta would
    then be recorded despite the foreign PID, reproducing the contamination
    shape #3266 hypothesises as what killed #2094's first attempt.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    _patch_free_mb(monkeypatch, [2048, 1948])  # a real 100 MB delta
    fake = _FakePynvml([os.getpid(), os.getpid() + 999])  # a foreign PID
    monkeypatch.setattr(main, "_load_pynvml", lambda: fake)  # later setattr wins

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, True)]


def test_asr_warm_reservation_discards_when_nvml_is_unavailable(monkeypatch) -> None:
    """Fail-conservative, warm mirror of the cold
    `test_asr_cold_reservation_discards_when_nvml_is_unavailable`: with no
    NVML the delta is unattributable, and on a device-wide reading that is
    precisely #2682's noise shape — so it must be dropped, not trusted. This
    is the guard #2094's first attempt lacked.

    Mutation that must fail it — loosen either foreign comparison to
    `is True` (treating None — "couldn't determine" — as trustworthy): the
    100 MB delta would then be recorded despite NVML being unavailable.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    _patch_free_mb(monkeypatch, [2048, 1948])  # a real 100 MB delta
    monkeypatch.setattr(main, "_load_pynvml", lambda: None)  # NVML unavailable

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, True)]


def test_asr_warm_reservation_discards_when_another_engine_holds_the_device(monkeypatch) -> None:
    """Warm mirror of the ledger guard
    (`test_asr_reservation_discards_when_another_engine_holds_the_device`):
    a concurrent Coqui reservation on the same card during the forward's
    window contaminates a device-wide delta, so `asr.warm` must check
    `engines_holding` exactly like the cold path does.

    Mutation that must fail it — drop the `not warm_other_engines` clause:
    the 100 MB delta (really Coqui's render) would be recorded as warm ASR.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    _patch_free_mb(monkeypatch, [2048, 1948])  # a real 100 MB delta

    async def body():
        coqui_token = pc.ledger.hold(devices[0]["kind"] + ":0", 3000, "coqui")
        try:
            async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
                pass
        finally:
            pc.ledger.release(coqui_token)
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, True)]


def test_asr_warm_reservation_does_not_double_guard_non_positive_deltas(monkeypatch) -> None:
    """#3265/#3266: a non-positive delta is the job of `record()`'s existing
    `observed_mb <= 0` guard — `reservation()` must NOT invent a second one.
    A negative raw delta (free 1948 -> 2048, memory FREED during the forward
    — e.g. allocator-cache eviction on a device-wide reading) reaches
    `record()` verbatim, where the single owner of that rule drops it (the
    real table's dropping is asserted in test_footprints.py).

    Mutation that must fail it — add a `warm_after_mb < warm_before_mb`
    guard to `reservation()`'s warm block: `record()` would see 0 via the
    `or 0` instead of -100, silently duplicating the drop rule in a place
    where it can drift from `record()`'s.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    _patch_free_mb(monkeypatch, [1948, 2048])  # free went UP: raw delta -100

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, -100, True)]


def test_asr_warm_reservation_discards_a_delta_above_the_seed_ceiling(monkeypatch) -> None:
    """#3282 review — the three guards above (after-reading present, no
    OTHER sidecar engine holding the device, no foreign PID at either end)
    only catch a hold that spans the WHOLE measurement window. A same-process
    sibling reservation (e.g. a Kokoro `/load` or a Qwen `/design-voice`/
    `/mint`) that opens AND closes entirely INSIDE this window is invisible
    to all three: `warm_other_engines` is read only at the tail of the
    window, and no foreign (non-sidecar) PID is ever involved. Left
    unguarded, that free-memory swing gets attributed whole to `asr.warm`,
    inflating the learned footprint into the thousands of MB and making
    ordinary VRAM-capacity checks reject requests they shouldn't.

    A device-wide delta above the `asr` cold seed (400 MB) is implausible for
    a resident forward — it should never need more than a cold load would —
    so it must be discarded (recorded 0) exactly like the other contamination
    guards, not attributed to ASR.

    Mutation that must fail it — breaks the PRODUCER: drop the warm-ceiling
    check (always accept `warm_delta_mb`). The 2000 MB delta would then be
    recorded verbatim instead of discarded.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    # before=10000 free, after=8000 free -> a 2000 MB delta, well above the
    # 400 MB "asr" cold seed used as the warm ceiling.
    _patch_free_mb(monkeypatch, [10000, 8000])

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, True)]


def test_asr_warm_reservation_keeps_a_delta_within_the_seed_ceiling(monkeypatch) -> None:
    """Non-regression twin of the ceiling test above: a genuine warm delta
    AT OR BELOW the `asr` cold seed (400 MB) must still be recorded normally
    — the new guard must not over-discard a plausible resident-forward
    reading.

    Mutation that must fail it — tighten the ceiling comparison (e.g. `>=`
    instead of `>`, or cap at some value below the real 400 MB delta used
    here). The genuine 400 MB delta would then be discarded (recorded 0)
    instead of kept.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    # before=2500 free, after=2100 free -> a 400 MB delta, exactly at the
    # "asr" cold seed ceiling — must still be kept, not discarded.
    _patch_free_mb(monkeypatch, [2500, 2100])

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 400, True)]


def test_asr_warm_reservation_ceiling_scales_with_configured_model_tier(monkeypatch) -> None:
    """#3357 N2 regression (S2): the warm ceiling must scale with the
    CONFIGURED ASR_MODEL the same way the cold seed does (#3347/#3352) — a
    large-tier warm delta above the flat 400 MB base seed but still under
    the large-model ceiling (2560 MB) must be KEPT, not discarded.

    Mutation that must fail it — revert `main.py`'s warm-ceiling lookup
    (`FootprintTable._seed_mb("asr", "asr", cfg, model)`) back to the flat
    `SEED_FOOTPRINTS_MB["asr"]` (400) it replaced: the same 1800 MB delta
    below would then exceed the flat ceiling and be discarded (recorded 0)
    instead of kept.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))
    # before=3000 free, after=1200 free -> a 1800 MB delta: above the flat
    # 400 MB base seed, but under the large-model 2560 MB ceiling.
    _patch_free_mb(monkeypatch, [3000, 1200])

    async def body():
        async with pc.reservation("asr", "large-v3", {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", "large-v3", {}, 1800, True)]


def test_asr_cold_measurement_is_not_capped(monkeypatch) -> None:
    """The COLD path (this test) has never had a ceiling — only the
    RESIDENT ("asr.warm") case does (#3282's restored guard, see
    `test_asr_warm_reservation_discards_a_delta_above_the_seed_ceiling`
    above). Both cases now take the same `_device_free_mb`-delta path
    (#3266); a cold observation — even an unusually large one — is NOT
    capped here regardless. FootprintTable's own p95 windowing is what
    tames a cold-side outlier, matching every other key's "up OR down"
    learning philosophy.

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
# #3036/#3265 — direct tests of `_own_process_used_mb`'s None contract.
# #3266 retired the method from the warm before/after producer role (WDDM
# reports no own-PID memory on this box — see
# docs/testing/onbox-3036-results/step-1-nvml.md), but kept it, tested and
# working, deliberately: deleting it is a separate human decision. Every
# failure mode MUST yield None, never 0: `record()`'s `<= 0` guard cannot
# tell "own process holds nothing" from "could not measure" if failures also
# read 0 — the same reasoning as `_device_free_mb`'s None contract.
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
