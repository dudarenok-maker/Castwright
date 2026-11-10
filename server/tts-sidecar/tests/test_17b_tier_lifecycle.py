"""#4079 — the 1.7B-Base tier must not be evicted by the admission of the very
request that is about to use it (A122 Finding 1 / A120 F9), and an admission
evict must not be logged as the idle watchdog."""
from __future__ import annotations

import asyncio
import logging
import sys
import threading
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def dev(free):
    return {"kind": "cuda", "index": 0, "label": "g", "totalMb": 8192, "freeMb": free}


def controller(free, evicted, own):
    """8 GB card; the 1.7B request books 6144 cold. `free` is what is left with
    the 1.7B-Base resident."""
    state = {"free": free}

    def free_base17():
        evicted.append("qwen.base17")
        state["free"] += 3400
        return True

    fp = type("F", (), {"peak_mb": lambda *_: 6144, "record": lambda *_: None})()
    return main.PlacementController(
        probe=lambda: [dev(state["free"])],
        footprints=fp,
        ledger=main.ReservationLedger(),
        reserve_mb=lambda: 500,
        idle_evict_steps=lambda dk, eng: [main.EvictStep("qwen.base17", None, free_base17)],
        is_resident=lambda e: "cuda:0",
        own_resident_tier=lambda e, m, c: own,
    )


def test_resident_own_tier_is_credited_and_not_evicted():
    evicted: list[str] = []

    async def body():
        pc = controller(4600, evicted, ("qwen.base17", 3400))
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as admission:
            assert admission["device"] == "cuda:0"

    asyncio.run(body())
    assert evicted == []


def test_cold_request_still_evicts_when_the_tier_is_not_resident():
    """Control: with no own-tier credit the same numbers DO need the evict, so
    the test above cannot pass by the ladder simply not running."""
    evicted: list[str] = []

    async def body():
        pc = controller(4600, evicted, (None, 0))
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as admission:
            assert admission["device"] == "cuda:0"

    asyncio.run(body())
    assert evicted == ["qwen.base17"]


def test_protected_tier_is_never_evicted_even_when_nothing_fits():
    evicted: list[str] = []

    async def body():
        pc = controller(500, evicted, ("qwen.base17", 3400))
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as admission:
            assert "noCapacity" in admission

    asyncio.run(body())
    assert evicted == []


def test_admit_also_skips_the_protected_tier():
    evicted: list[str] = []

    async def body():
        pc = controller(4600, evicted, ("qwen.base17", 3400))
        return await pc.admit("qwen", "1.7b", {}, cpu_capable=False, heavy=True)

    assert asyncio.run(body()) == {"device": "cuda:0"}
    assert evicted == []


def _fake_qwen(resident=True):
    q = object.__new__(main.QwenEngine)
    q._base17 = object() if resident else None
    q._base17_last_used = 0.0
    q._base17_in_flight = main.InFlightCounter()
    q._synth_lock = threading.Lock()
    q._device = "cuda:0"
    return q


def test_own_resident_tier_resolver(monkeypatch):
    monkeypatch.setitem(main.ENGINES, "qwen", _fake_qwen(True))
    assert main._own_resident_tier("qwen", "1.7b", {}) == ("qwen.base17", main._QWEN_BASE17_WEIGHTS_MB)
    assert main._own_resident_tier("qwen", "1.7b", None)[0] == "qwen.base17"
    assert main._own_resident_tier("qwen", "0.6b", {}) == (None, 0)
    assert main._own_resident_tier("qwen", None, {}) == (None, 0)
    assert main._own_resident_tier("qwen", "1.7b", {"op": "design"}) == (None, 0)
    assert main._own_resident_tier("qwen", "1.7b", {"op": "mint"}) == (None, 0)
    assert main._own_resident_tier("coqui", "1.7b", {}) == (None, 0)
    monkeypatch.setitem(main.ENGINES, "qwen", _fake_qwen(False))
    assert main._own_resident_tier("qwen", "1.7b", {}) == (None, 0)


def test_admission_evict_log_does_not_say_idle_watchdog(monkeypatch, caplog):
    qwen = _fake_qwen(True)
    monkeypatch.setitem(main.ENGINES, "qwen", qwen)
    monkeypatch.setattr(main, "_reclaim_host_and_vram", lambda: None)
    monkeypatch.setattr(main, "_same_card", lambda a, b: True)
    step = next(s for s in main._idle_evict_steps("cuda:0", "kokoro") if s.name == "qwen.base17")
    with caplog.at_level(logging.INFO):
        assert step.run() is True
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "1.7B-Base unloaded (evicted for admission)" in text
    assert "idle watchdog" not in text


def test_watchdog_evict_log_still_says_idle_watchdog(monkeypatch, caplog):
    qwen = _fake_qwen(True)
    monkeypatch.setattr(main, "_reclaim_host_and_vram", lambda: None)
    with caplog.at_level(logging.INFO):
        assert qwen.maybe_free_idle_base17(0.0) is True
    assert "1.7B-Base unloaded (idle watchdog)" in " ".join(r.getMessage() for r in caplog.records)
