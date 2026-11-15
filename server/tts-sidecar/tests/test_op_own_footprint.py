"""#4163 — a learned VRAM footprint is the op's OWN increment, learned only from
a COLD op (no model of the engine present at admission).

`_reset_peak_mb` returns a baseline (`memory_allocated` right after the peak
reset); `_observed_mb(device_key, baseline)` returns `max_memory_allocated -
baseline` floored at 0, and 0 for a `None` baseline. `_resolve_admission` voids
the baseline for a warm non-ASR op via `any_model_resident`, and
`reservation()` carries the baseline per reservation. ASR is untouched.

All tests use a fake `torch` module (no GPU): `sys.modules["torch"]` is
replaced, because `main` imports torch lazily inside the helpers."""
from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path
from typing import Optional

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

_RAN = object()
MB = 1_048_576


def run_case(coro):
    assert asyncio.run(coro) is _RAN, "async test body did not run to completion"


def dev(kind="cuda", index=0, total=24000, free=20000):
    return {"kind": kind, "index": index, "label": "g", "totalMb": total, "freeMb": free}


class _FakeCuda:
    """Per-index allocated/peak in bytes, exposed in MiB through the helpers."""

    def __init__(self) -> None:
        self.allocated: dict[int, int] = {}
        self.peak: dict[int, int] = {}
        self.resets: list[int] = []
        self.raise_on_allocated = False

    def memory_allocated(self, i):
        if self.raise_on_allocated:
            raise RuntimeError("boom")
        return self.allocated.get(i, 0)

    def max_memory_allocated(self, i):
        return self.peak.get(i, 0)

    def reset_peak_memory_stats(self, i):
        self.resets.append(i)
        self.peak[i] = self.allocated.get(i, 0)

    # test helpers
    def alloc(self, i, mb):
        self.allocated[i] = self.allocated.get(i, 0) + mb * MB
        self.peak[i] = max(self.peak.get(i, 0), self.allocated[i])

    def free(self, i, mb):
        self.allocated[i] = self.allocated.get(i, 0) - mb * MB


@pytest.fixture
def cuda(monkeypatch):
    fake = _FakeCuda()
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(cuda=fake))
    return fake


class _RecordingFootprints:
    def __init__(self, peak: int = 100) -> None:
        self._peak = peak
        self.records: list[tuple] = []

    def peak_mb(self, engine, model, cfg, resident=False):  # noqa: D102
        return self._peak

    def record(self, engine, model, cfg, observed_mb, resident=False):  # noqa: D102
        self.records.append((engine, model, cfg, observed_mb, resident))


def make_pc(any_model_resident, footprints=None, peak=100):
    fp = footprints if footprints is not None else _RecordingFootprints(peak)
    pc = main.PlacementController(
        probe=lambda: [dev()],
        footprints=fp,
        ledger=main.ReservationLedger(),
        reserve_mb=lambda: 200,
        idle_evict_steps=lambda dk, eng: [],
        is_resident=lambda e: None,
        any_model_resident=any_model_resident,
    )
    return pc, fp


def test_o1_helpers(cuda):
    """O1. Mutation M3 (drop the max(...,0) floor) turns the floor assertion red."""
    cuda.alloc(1, 1000)
    assert main.PlacementController._reset_peak_mb("cuda:1") == 1000
    assert cuda.resets == [1]
    cuda.alloc(1, 500)
    assert main.PlacementController._observed_mb("cuda:1", 1000) == 500
    cuda.free(1, 900)
    main.PlacementController._reset_peak_mb("cuda:1")
    assert main.PlacementController._observed_mb("cuda:1", 1000) == 0
    assert main.PlacementController._reset_peak_mb("cpu") is None
    assert main.PlacementController._observed_mb("cpu", 0) == 0
    assert main.PlacementController._observed_mb("cuda:1", None) == 0


def test_o2_warm_op_beside_resident_engine_records_nothing(cuda):
    """O2. Mutation M5 (drop the cold-only gate) turns this red: it records 600."""
    cuda.alloc(0, 3400)
    cuda.alloc(0, 1800)
    pc, fp = make_pc(lambda e: e in ("coqui", "qwen"))

    async def body():
        async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True):
            cuda.alloc(0, 600)
            cuda.free(0, 600)
        return _RAN

    run_case(body())
    assert fp.records == [("coqui", None, {}, 0, False)]


def test_o3_cold_load_counts_own_weights_not_other_engines(cuda):
    """O3. Mutation M1 (subtract 0 not the baseline) records 5600 and turns this red."""
    cuda.alloc(0, 3400)
    pc, fp = make_pc(lambda e: e == "qwen")

    async def body():
        async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True):
            cuda.alloc(0, 1800)
            cuda.alloc(0, 400)
            cuda.free(0, 400)
        return _RAN

    run_case(body())
    assert fp.records[0][3] == 2200


def test_o4_warm_ops_cannot_pull_a_cold_learned_p95_down(cuda):
    """O4. Mutation M5 turns this red: the peak collapses to 300 and sample_count hits 64."""
    fp = main.FootprintTable()
    warm = {"v": False}
    pc, _ = make_pc(lambda e: warm["v"], footprints=fp)

    async def body():
        for _ in range(5):
            async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True):
                cuda.alloc(0, 2200)
            cuda.free(0, 2200)  # simulate the unload after the op
        warm["v"] = True
        cuda.alloc(0, 1800)
        # 100 > the 64-sample window: the cold samples would be fully displaced
        # if warm ops recorded anything.
        for _ in range(100):
            async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True):
                cuda.alloc(0, 300)
                cuda.free(0, 300)
        return _RAN

    run_case(body())
    assert fp.peak_mb("coqui", None, {}) == 2200
    assert fp.snapshot()["coqui"]["sample_count"] == 5


def test_o5_overlapping_reservations_keep_their_own_baselines(cuda):
    """O5. Mutation M2 (baseline stored on the controller) makes A record 200."""
    cuda.alloc(0, 1000)
    pc, fp = make_pc(lambda e: False)

    async def body():
        async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True):
            cuda.alloc(0, 300)
            async with pc.reservation("qwen", None, {}, cpu_capable=False, heavy=True):
                cuda.alloc(0, 200)
        return _RAN

    run_case(body())
    by_engine = {r[0]: r[3] for r in fp.records}
    assert by_engine["qwen"] == 200  # 1500 - 1300
    # 500 includes B's 200, and B's reset discarded A's pre-B peak. That is the
    # per-device counter residual: pre-existing, not fixed by #4163.
    assert by_engine["coqui"] == 500  # 1500 - 1000


def test_o6_failed_baseline_discards(cuda):
    """O6. Mutation M4 (None baseline treated as 0) records 700 and turns this red."""
    cuda.raise_on_allocated = True
    pc, fp = make_pc(lambda e: False)

    async def body():
        async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True):
            cuda.alloc(0, 700)
        return _RAN

    run_case(body())
    assert fp.records[0][3] == 0


def _qwen_stub(**over):
    q = object.__new__(main.QwenEngine)
    q._base = None
    q._base17 = None
    q._design = None
    q._design_in_flight = types.SimpleNamespace(busy=False)
    for k, v in over.items():
        setattr(q, k, v)
    return q


def test_o7_production_predicate_and_wiring(monkeypatch):
    """O7. Mutation M6 (Qwen branch -> `_is_resident("qwen") is not None`) turns the
    `_base17`-only case red."""
    monkeypatch.setitem(main.ENGINES, "qwen", _qwen_stub())
    assert main._engine_any_model_resident("qwen") is False
    monkeypatch.setitem(main.ENGINES, "qwen", _qwen_stub(_base17=object()))
    assert main._engine_any_model_resident("qwen") is True
    monkeypatch.setitem(
        main.ENGINES, "qwen", _qwen_stub(_design_in_flight=types.SimpleNamespace(busy=True))
    )
    assert main._engine_any_model_resident("qwen") is True
    monkeypatch.setitem(main.ENGINES, "qwen", object())
    assert main._engine_any_model_resident("qwen") is True
    monkeypatch.setattr(main, "_is_resident", lambda e: "cuda:0")
    assert main._engine_any_model_resident("coqui") is True
    monkeypatch.setattr(main, "_is_resident", lambda e: None)
    assert main._engine_any_model_resident("coqui") is False
    assert main._placement.any_model_resident is main._engine_any_model_resident


def test_o8_cold_asr_never_calls_the_predicate(monkeypatch):
    """O8. ASR keeps its device-wide free delta; the predicate must not run for it."""

    def boom(engine):
        raise AssertionError("any_model_resident must not be called for asr")

    monkeypatch.setattr(main.PlacementController, "_device_free_mb", staticmethod(lambda device_key: 77))
    pc, fp = make_pc(boom)

    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=True):
            pass
        return _RAN

    run_case(body())
