"""#2094 review — the ASR-specific free-memory-DELTA measurement
`PlacementController.reservation()` uses instead of the torch-allocator
peak every other engine uses. faster-whisper's CTranslate2 backend
allocates outside torch's caching allocator, so `_observed_mb`
(`torch.cuda.max_memory_allocated`) reads ~0 for a warm ASR forward and
whatever residual torch activity happened to be co-resident for a cold
one — the root cause `asr.warm` was never expected to learn from, and a
plausible source of the contaminated 3707 MB `asr` figure #2094 itself
reported.

These drive `reservation()` end-to-end for `engine="asr"` with
`PlacementController._device_free_mb` monkeypatched to a scripted
before/after sequence — no real CUDA needed — and assert on what reaches
`footprints.record()`."""
from __future__ import annotations

import asyncio
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
    scripted sequence in call order."""
    calls = list(sequence)

    def fake(device_key):
        assert calls, "fake _device_free_mb called more times than scripted"
        return calls.pop(0)

    monkeypatch.setattr(main.PlacementController, "_device_free_mb", staticmethod(fake))


def test_asr_cold_reservation_records_the_free_memory_delta(monkeypatch) -> None:
    """Cold (not resident): before=5000, after=4900 -> a 100 MB delta is
    exactly what a genuine cold-load observation should look like, and
    nothing here caps it.

    Mutation that must fail it — breaks the PRODUCER: revert `reservation()`'s
    `observed_mb = asr_observed_mb if engine == "asr" else self._observed_mb(...)`
    back to unconditionally calling `self._observed_mb(device_key)` (the
    torch-allocator path) — with no real torch/CUDA, that returns 0 and this
    test's delta assertion fails.
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


def test_asr_warm_measurement_discards_an_implausible_delta(monkeypatch) -> None:
    """RESIDENT ASR (warm): a delta bigger than the cold-load seed (400 MB)
    is implausible on its face — a warm forward should never need more VRAM
    than a cold load, so a reading this large is treated as contamination
    (a foreign, non-ledger process on the same card, e.g. #2094's own
    3707 MB finding) and discarded rather than trusted. Conservative, not
    optimistic, per the review.

    Mutation that must fail it — breaks the PRODUCER: drop the
    `not (resident and warm_ceiling > 0 and delta > warm_ceiling)` guard. The
    3707 MB delta would then be recorded as a genuine "asr.warm" observation.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    _patch_free_mb(monkeypatch, [10000, 6293])  # a 3707 MB delta — #2094's own figure

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 0, True)]


def test_asr_warm_measurement_keeps_a_plausible_delta(monkeypatch) -> None:
    """RESIDENT ASR (warm): a small delta — well under the cold seed — is
    exactly the incremental per-forward figure `asr.warm` exists to learn.
    Not discarded."""
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")
    _patch_free_mb(monkeypatch, [10000, 9910])  # a 90 MB delta — plausible warm cost

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 90, True)]


def test_asr_cold_measurement_is_not_capped_by_the_warm_ceiling(monkeypatch) -> None:
    """The implausible-delta ceiling is WARM-only (review: "a warm forward
    should never need more than a cold load"). A cold observation — even an
    unusually large one — is NOT capped here; FootprintTable's own p95
    windowing is what tames a cold-side outlier, matching every other key's
    "up OR down" learning philosophy.

    Mutation that must fail it — breaks the PRODUCER: apply the warm ceiling
    unconditionally (drop the `resident and` clause). A cold 3707 MB delta
    would then be discarded (recorded as 0) instead of kept.
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
