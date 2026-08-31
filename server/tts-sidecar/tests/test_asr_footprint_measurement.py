"""#2094 review — the ASR-specific free-memory-DELTA measurement
`PlacementController.reservation()` uses for a COLD `asr` load, instead of
the torch-allocator peak every other engine (and, since #2682, a RESIDENT
"asr.warm" forward too) uses. faster-whisper's CTranslate2 backend
allocates its weights entirely outside torch's caching allocator, so a
cold `_observed_mb` (`torch.cuda.max_memory_allocated`) reading is
whatever residual torch activity happened to be co-resident — a plausible
source of the contaminated 3707 MB `asr` figure #2094 itself reported.

#2682: the device-wide delta this module exercises essentially never
returned a positive `asr.warm` sample in practice, so `reservation()` now
measures a RESIDENT ASR forward via `_observed_mb` instead, same as every
other key — see `test_asr_warm_measurement_uses_the_torch_allocator_path` for that path.
This module now covers the COLD `asr` delta only.

These drive `reservation()` end-to-end for `engine="asr"` with
`PlacementController._device_free_mb` monkeypatched to a scripted
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
    def __init__(self, pid: int) -> None:
        self.pid = pid


class _FakePynvml:
    """A scripted stand-in for the real `pynvml` module, injected via
    `main._load_pynvml` so `_foreign_pid_holds_device`'s real body (index
    parsing, handle lookup, process-list comparison, shutdown) runs
    end-to-end without a real NVML/driver present."""

    def __init__(self, pids: list[int], raise_on_init: bool = False) -> None:
        self._pids = pids
        self._raise_on_init = raise_on_init
        self.shutdown_called = False

    def nvmlInit(self):  # noqa: N802 - matches real pynvml's naming
        if self._raise_on_init:
            raise RuntimeError("cuda driver can't be loaded")

    def nvmlDeviceGetHandleByIndex(self, index):  # noqa: N802
        return f"handle-{index}"

    def nvmlDeviceGetComputeRunningProcesses(self, handle):  # noqa: N802
        return [_FakeProc(pid) for pid in self._pids]

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


def test_asr_warm_measurement_uses_the_torch_allocator_path(monkeypatch) -> None:
    """RESIDENT ASR (warm) — #2682: `_device_free_mb` essentially never
    returned a positive `asr.warm` sample in practice, so the learned
    estimate could never move off its 128 MB seed. `reservation()` now
    measures a resident ASR forward via `_observed_mb` (the torch-allocator
    peak), matching every other engine's key, and never touches
    `_device_free_mb` for this case at all.

    Mutation that must fail it — breaks the PRODUCER: revert
    `reservation()`'s `observed_mb = asr_observed_mb if (engine == "asr" and
    not resident) else self._observed_mb(...)` back to `asr_observed_mb if
    engine == "asr" else ...`. `asr_observed_mb` stays `None` for a resident
    op (mem_before_mb is never set for it, see `_resolve_admission`), so the
    mutated version would record 0 instead of falling through to
    `_observed_mb`.
    """
    devices = [dev(total=16000, free=16000)]
    pc, fp = make_pc(devices, peak=128, resident=lambda e: "cuda:0")

    def fail_if_called(device_key):
        raise AssertionError("_device_free_mb must not be called for a resident ASR forward")

    monkeypatch.setattr(main.PlacementController, "_device_free_mb", staticmethod(fail_if_called))
    # Stubbed (rather than relying on the no-CUDA-in-CI 0 every other test in
    # this module uses) so this test can tell "used _observed_mb" apart from
    # "asr_observed_mb stayed None and fell through to `or 0`" — both read 0
    # without a real torch/CUDA device, which would let the mutation named
    # above pass by coincidence.
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 77))

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False):
            pass
        return _RAN

    run_case(body())

    assert fp.records == [("asr", None, {}, 77, True)]


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
