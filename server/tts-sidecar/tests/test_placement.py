"""Tests for `ReservationLedger` + `PlacementController` — the core
peak-reservation admission logic of capacity-aware GPU placement (task 3 of
the vram-aware-placement plan).

Contract pinned here: `admit()` reserves the FootprintTable's peak-mb
estimate for the winning device so a second concurrent op can't double-book
VRAM the first one already claimed; `reservation()` releases that hold (and
records the observed peak) on exit, whether the op succeeded or raised."""
from __future__ import annotations

import asyncio
import sys
import threading
import time
from pathlib import Path

import pytest

# Add the sidecar root to sys.path so `import main` works regardless of
# pytest's collection directory — same pattern as test_capacity.py.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def dev(kind="cuda", index=0, total=8192, free=8000):
    return {"kind": kind, "index": index, "label": "g", "totalMb": total, "freeMb": free}


# --- _device_reserve_mb -----------------------------------------------------
#
# The per-device VRAM safety cushion: min(5% of that device's own VRAM, the
# GPU_RESERVE_MB cap) — right-sizes the reserve to the card instead of
# subtracting one flat number everywhere (over-provisions a small card,
# under-provisions a large one relative to its size).


@pytest.mark.parametrize(
    "total_mb,cap,expected",
    [
        (8188, 500, 409),  # 5% of an ~8 GB card, under the cap
        (6144, 500, 307),  # 5% of a 6 GB card, under the cap
        (16302, 500, 500),  # 5% of a 16 GB card (815) exceeds the cap -> capped
        (24576, 500, 500),  # 5% of a 24 GB card (1229) exceeds the cap -> capped
    ],
)
def test_device_reserve_mb(total_mb, cap, expected):
    assert main._device_reserve_mb(total_mb, cap) == expected


def make(devices, peak, reserve_cap=768, idle_evict_steps=None, resident=None):
    fp = type("F", (), {"peak_mb": lambda *_: peak, "record": lambda *_: None})()
    return main.PlacementController(
        probe=lambda: devices,
        footprints=fp,
        ledger=main.ReservationLedger(),
        reserve_mb=lambda: reserve_cap,
        idle_evict_steps=idle_evict_steps or (lambda dk, eng: []),
        is_resident=resident or (lambda e: None),
    )


def test_reserves_peak_so_second_op_cannot_double_book():
    devices = [dev(free=8000, total=8192)]
    pc = make(devices, peak=5600)
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as a1:
        assert a1["device"] == "cuda:0"
        # second op: the per-device reserve on an 8192 MB card is
        # min(round(0.05*8192), 768) = 410, so headroom = min(8000, 8192 -
        # 5600(reserved)) - 410 = 2592 - 410 = 2182 < 5600 -> no capacity
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
    ledger = main.ReservationLedger()
    tok = ledger.hold("cuda:0", 6000, "qwen")
    fp = type("F", (), {"peak_mb": lambda *_: 5600, "record": lambda *_: None})()
    pc = main.PlacementController(
        probe=lambda: devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=lambda dk, eng: [
            main.EvictStep("release", None, lambda: (ledger.release(tok) or True))
        ],
        is_resident=lambda e: None,
    )
    assert pc.admit("qwen", "q", {}, False, True)["device"] == "cuda:0"


def test_starved_qwen_admits_after_coqui_is_evicted():
    """`admit()` has NO production caller — every real call site (10+ in
    main.py) goes through `reservation()` instead. This test pins the
    retry logic at the `admit()` seam anyway (decide-without-hold, same
    retry shape); `test_starved_qwen_reservation_admits_after_coqui_is_evicted`
    below is the real end-to-end proof, driven through the actual
    production entry point.

    An idle-but-resident Coqui holds NO reservation in production — its
    token is released the moment `reservation()` exits (#1920B). So the
    "Coqui is occupying VRAM" fact is modelled here as low `freeMb` in the
    probe (5192, matching a device with 3000 MB used by the resident
    weights), not as a ledger hold; the injected evict raises `freeMb` back
    to 8000 once Coqui is unloaded, mirroring what the real GPU probe would
    report."""
    state = {"free": 5192}
    devices = lambda: [dev(free=state["free"])]
    ledger = main.ReservationLedger()
    fp = type("F", (), {"peak_mb": lambda *_: 5600, "record": lambda *_: None})()
    evicted = []

    def evict(device_key, engine):
        evicted.append((device_key, engine))
        state["free"] = 8000
        return True

    def steps(device_key, engine):
        if engine == "coqui":
            return []
        return [main.EvictStep("coqui", "coqui", lambda: evict(device_key, engine))]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    assert pc.admit("qwen", "q", {}, False, True)["device"] == "cuda:0"
    assert evicted == [("cuda:0", "qwen")]


def test_starved_qwen_reservation_admits_after_coqui_is_evicted():
    """#1894 end to end at the ACTUAL production seam: every real call site
    uses `reservation()` (a @contextmanager), not `admit()` (see the note on
    the sibling test above). A starved qwen op is admitted once the idle
    Coqui occupying the device's VRAM is evicted by the injected
    `idle_evict_steps` (modelled as low `freeMb`, not a ledger hold — see the note
    on the sibling test above)."""
    state = {"free": 5192}
    devices = lambda: [dev(free=state["free"])]
    ledger = main.ReservationLedger()
    fp = type("F", (), {"peak_mb": lambda *_: 5600, "record": lambda *_: None})()
    evicted = []

    def evict(device_key, engine):
        evicted.append((device_key, engine))
        state["free"] = 8000
        return True

    def steps(device_key, engine):
        if engine == "coqui":
            return []
        return [main.EvictStep("coqui", "coqui", lambda: evict(device_key, engine))]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as admission:
        assert admission["device"] == "cuda:0"
    assert evicted == [("cuda:0", "qwen")]


# --- step-wise eviction with a real re-probe (#1920A + #1920B) --------------
#
# `PlacementController._evict_until` drives `idle_evict_steps(...)` one step
# at a time, re-probing after each and stopping the moment the starved op
# actually fits — instead of the old `_idle_evict` running every branch
# unconditionally and accumulating `freed = X or freed`. Every test below
# mutates the fake probe's `freeMb` from inside a step's `run()`, never just
# returns True — a step that "succeeds" without changing capacity would let a
# broken short-circuit (or a broken loop) pass unnoticed.


def test_a_small_op_satisfied_by_the_first_step_leaves_coqui_resident():
    """A 400 MB ASR op on a full card: freeing the cheap engine is enough, so
    the ~90s-to-reload Coqui must never be touched.

    Fails against the wrong implementation: today every branch runs
    unconditionally, so `evicted` would end as ['asr', 'coqui'] instead of
    stopping after the first sufficient step."""
    state = {"free": 200, "total": 8192}
    devices = lambda: [dev(free=state["free"], total=state["total"])]
    ledger = main.ReservationLedger()
    fp = type("F", (), {"peak_mb": lambda *_: 400, "record": lambda *_: None})()
    evicted = []
    coqui_touched = []

    def free_asr():
        evicted.append("asr")
        state["free"] += 5000  # the cheap engine alone frees plenty
        return True

    def free_coqui():
        coqui_touched.append("coqui")
        state["free"] += 3000
        return True

    def steps(device_key, engine):
        return [
            main.EvictStep("asr", "asr", free_asr),
            main.EvictStep("coqui", "coqui", free_coqui),
        ]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    with pc.reservation("asr", None, {}, cpu_capable=False, heavy=True) as admission:
        assert admission["device"] == "cuda:0"
    assert evicted == ["asr"]
    assert coqui_touched == []  # the ~90s reload was never needed


def test_a_large_op_the_first_step_cannot_satisfy_still_reaches_coqui():
    """The guard against over-correcting. A 6 GB op is NOT satisfied by
    freeing 200 MB, so the loop must keep going and still reach Coqui.

    Fails against the naive `if not freed: ...` one-liner, which stops after
    the first success and never frees enough — admission would report
    noCapacity even though Coqui's freed VRAM would have been enough."""
    state = {"free": 500, "total": 8192}
    devices = lambda: [dev(free=state["free"], total=state["total"])]
    ledger = main.ReservationLedger()
    fp = type("F", (), {"peak_mb": lambda *_: 6000, "record": lambda *_: None})()
    evicted = []

    def free_asr():
        evicted.append("asr")
        state["free"] += 200  # not enough on its own
        return True

    def free_coqui():
        evicted.append("coqui")
        state["free"] += 6000  # this one is enough
        return True

    def steps(device_key, engine):
        return [
            main.EvictStep("asr", "asr", free_asr),
            main.EvictStep("coqui", "coqui", free_coqui),
        ]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as admission:
        assert admission["device"] == "cuda:0"
    assert evicted == ["asr", "coqui"]  # both steps had to run


def test_an_engine_holding_a_reservation_is_not_evicted():
    """#1920B. Hold a Coqui reservation on cuda:0, then admit a starved Qwen
    op.

    Fails against the wrong implementation: without the ledger check the
    Coqui step runs and the reserved model is thrown away — admission would
    then succeed with `coqui_touched` non-empty instead of reporting
    noCapacity."""
    state = {"free": 500, "total": 8192}
    devices = lambda: [dev(free=state["free"], total=state["total"])]
    ledger = main.ReservationLedger()
    ledger.hold("cuda:0", 3000, "coqui")  # coqui's op is mid-flight, holding VRAM
    fp = type("F", (), {"peak_mb": lambda *_: 3000, "record": lambda *_: None})()
    coqui_touched = []

    def free_coqui():
        coqui_touched.append("coqui")
        state["free"] += 3000
        return True

    def steps(device_key, engine):
        return [main.EvictStep("coqui", "coqui", free_coqui)]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as admission:
        assert admission == {"noCapacity": {"neededMb": 3000, "deviceKey": "cuda:0"}}
    assert coqui_touched == []


def test_reserved_key_not_name_gates_the_ledger_skip():
    """The #1920B skip must key off `reserved_key`, never `name`. A step named
    something else entirely but carrying `reserved_key="coqui"` must still be
    skipped while Coqui holds a reservation.

    Fails against `step.name in held_by` (comparing name instead of
    reserved_key): name "x" is never held, so the mutated skip would let this
    step run, and admission would wrongly succeed instead of reporting
    noCapacity."""
    state = {"free": 500, "total": 8192}
    devices = lambda: [dev(free=state["free"], total=state["total"])]
    ledger = main.ReservationLedger()
    ledger.hold("cuda:0", 3000, "coqui")  # coqui's op is mid-flight, holding VRAM
    fp = type("F", (), {"peak_mb": lambda *_: 3000, "record": lambda *_: None})()
    ran = []

    def free_mismatched_name():
        ran.append("x")
        state["free"] += 3000
        return True

    def steps(device_key, engine):
        # name != reserved_key on purpose — the skip must key off reserved_key.
        return [main.EvictStep("x", "coqui", free_mismatched_name)]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as admission:
        assert admission == {"noCapacity": {"neededMb": 3000, "deviceKey": "cuda:0"}}
    assert ran == []  # skipped: reserved_key="coqui" matched the held engine


def test_reserved_key_none_is_not_skipped_even_if_name_matches_held_engine():
    """The twin case: a step literally NAMED "coqui" but with reserved_key=None
    must NOT be skipped, even while a "coqui" reservation is held — this
    step's ledger granularity is deliberately not engine-keyed (mirrors the
    real Qwen steps' `reserved_key=None`).

    Fails the same mutation from the other side: `step.name in held_by` WOULD
    skip this step (name "coqui" IS held), wrongly denying an eviction that
    should run and reporting noCapacity instead of admitting."""
    state = {"free": 500, "total": 8192}
    devices = lambda: [dev(free=state["free"], total=state["total"])]
    ledger = main.ReservationLedger()
    ledger.hold("cuda:0", 3000, "coqui")  # coqui's op is mid-flight, holding VRAM
    fp = type("F", (), {"peak_mb": lambda *_: 3000, "record": lambda *_: None})()
    ran = []

    def free_named_coqui():
        ran.append("coqui")
        state["free"] += 3000
        return True

    def steps(device_key, engine):
        return [main.EvictStep("coqui", None, free_named_coqui)]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as admission:
        assert admission["device"] == "cuda:0"
    assert ran == ["coqui"]  # ran despite name=="coqui" matching a held engine


def test_declining_step_does_not_stop_the_loop():
    """Moved from test_devices.py's `_idle_evict` coverage (#1920A converted
    the `or freed` composition into a controller-driven loop). A step that
    returns False (declined) must not abort iteration — the loop keeps trying
    subsequent steps until one succeeds and `fits()` reports capacity.

    Fails against `if not step.run(): return None` (treating a decline as
    fatal instead of `continue`)."""
    state = {"free": 500, "total": 8192}
    devices = lambda: [dev(free=state["free"], total=state["total"])]
    ledger = main.ReservationLedger()
    fp = type("F", (), {"peak_mb": lambda *_: 3000, "record": lambda *_: None})()
    ran = []

    def declines():
        ran.append("declines")
        return False  # nothing freed; loop must continue

    def succeeds():
        ran.append("succeeds")
        state["free"] += 3000
        return True

    def steps(device_key, engine):
        return [
            main.EvictStep("declines", None, declines),
            main.EvictStep("succeeds", None, succeeds),
        ]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as admission:
        assert admission["device"] == "cuda:0"
    assert ran == ["declines", "succeeds"]


def test_a_raising_step_does_not_abort_the_loop():
    """Moved from test_devices.py's `_idle_evict` coverage (the old
    `except Exception: pass` swallow now lives in the controller loop). One
    engine's teardown raising must not deny the whole admission — eviction is
    best-effort, so the loop must skip the raiser and keep going.

    Fails against a loop with no try/except around `step.run()`: the
    RuntimeError would propagate out of the `with pc.reservation(...)` block
    instead of being swallowed."""
    state = {"free": 500, "total": 8192}
    devices = lambda: [dev(free=state["free"], total=state["total"])]
    ledger = main.ReservationLedger()
    fp = type("F", (), {"peak_mb": lambda *_: 3000, "record": lambda *_: None})()
    ran = []

    def raises():
        ran.append("raises")
        raise RuntimeError("boom")

    def succeeds():
        ran.append("succeeds")
        state["free"] += 3000
        return True

    def steps(device_key, engine):
        return [
            main.EvictStep("raises", None, raises),
            main.EvictStep("succeeds", None, succeeds),
        ]

    pc = main.PlacementController(
        probe=devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=steps,
        is_resident=lambda e: None,
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as admission:
        assert admission["device"] == "cuda:0"
    assert ran == ["raises", "succeeds"]


class _FakeStepQwen(main.QwenEngine):
    name = "qwen"

    def __init__(self, device):
        super().__init__()
        self._device = device

    def maybe_free_idle_design(self, ttl_seconds):
        return True

    def maybe_free_idle_base17(self, ttl_seconds):
        return True


class _FakeStepCoqui(main.CoquiEngine):
    def __init__(self, device):
        super().__init__()
        self._device = device

    def maybe_free_idle(self, ttl_seconds):
        return True


def test_steps_run_cheapest_reload_first(monkeypatch):
    """Ordering is load-bearing BECAUSE of the short-circuit: with it, the
    first sufficient step is the only one that runs, so the cheapest must be
    tried first — reload costs: ECAPA ~200 MB / ~1 s, ASR ~400 MB / ~1 s,
    Qwen VoiceDesign + 1.7B-Base seconds, Coqui XTTS ~3 GB / ~90 s.

    Also pins the #1920B ledger-guard wiring: spk/asr/coqui MUST carry their
    real `reserved_key` (the ledger can attribute a reservation to them), while
    the two Qwen steps MUST stay `None` (the ledger's per-engine granularity
    can't tell Qwen's models apart — see the long comment in
    `_idle_evict_steps`). Losing either half is a real regression: dropping
    the real keys re-enables an evict of an already-admitted model out from
    under its own worker thread; giving Qwen a real key makes one Qwen op's
    reservation starve a second Qwen op into a needless ~90s Coqui reload.

    Fails against a build that puts Coqui (or any of the transient engines)
    out of cheapest-first order, OR that gets any step's `reserved_key` wrong."""
    qwen = _FakeStepQwen("cuda:0")
    coqui = _FakeStepCoqui("cuda:0")
    asr = type("A", (), {"_device": "cuda:0", "maybe_free_idle": lambda self, ttl: True})()
    spk = type("S", (), {"device": "cuda:0", "maybe_free_idle": lambda self, ttl: True})()
    monkeypatch.setitem(main.ENGINES, "qwen", qwen)
    monkeypatch.setitem(main.ENGINES, "coqui", coqui)
    monkeypatch.setattr(main, "ASR", asr)
    monkeypatch.setattr(main, "SPK", spk)

    steps = main._idle_evict_steps("cuda:0", "asr")
    assert [(s.name, s.reserved_key) for s in steps] == [
        ("spk", "spk"),
        ("asr", "asr"),
        ("qwen.design", None),
        ("qwen.base17", None),
        ("coqui", "coqui"),
    ]


# --- plan 273: the evict + reclaim run on a worker thread, off the event
#     loop (T2, T3) ---------------------------------------------------------
#
# `_evict_until` is `async def` and offloads each step's `run()` via
# `asyncio.to_thread` — an engine lock is never acquired from the loop.
# Every test below drives a heartbeat task (ticking every 10ms) concurrently
# with the eviction and asserts it keeps ticking WHILE the step is parked —
# a stalled loop cannot advance the heartbeat, no matter how long the block
# lasts, because a synchronous block freezes the whole thread (nothing,
# including an overdue timer, can run until it releases). A stalled-loop
# mutation therefore starves the heartbeat to at most one stale catch-up
# tick in the same window that the fix lets it tick ~5 times.


def test_an_eviction_step_does_not_stall_the_event_loop():
    """T2: `_evict_until` must run each step's `run()` on a worker thread, not
    synchronously on the calling coroutine — a step that blocks (e.g. on a
    contended engine lock) must not stall other coroutines sharing the loop
    (e.g. /health).

    Mutation-fails against a `step.run()` revert (dropping the
    `asyncio.to_thread` wrap): the mutated step then executes synchronously
    on the loop's own thread the moment `_evict_until`'s task is scheduled,
    which freezes the ENTIRE thread for the duration of the step's own
    internal wait — nothing else, including this test's own heartbeat task,
    can run any code until that wait times out. The heartbeat can accrue at
    most one stale "catch-up" tick once the freeze ends (a coroutine's
    `asyncio.sleep` reschedules relative to `now`, so an overdue timer never
    bursts more than once), never the ~10+ real ticks the fix produces in the
    same 150ms window."""
    entry = threading.Event()
    release = threading.Event()

    def blocking_step() -> bool:
        entry.set()
        release.wait(timeout=1.0)
        return True

    async def body():
        ticks: list[int] = []

        async def heartbeat():
            while True:
                ticks.append(1)
                await asyncio.sleep(0.01)

        hb_task = asyncio.create_task(heartbeat())
        pc = make(
            [dev(free=500, total=8192)],
            peak=3000,
            idle_evict_steps=lambda dk, eng: [main.EvictStep("blocks", None, blocking_step)],
        )
        evict_task = asyncio.create_task(pc._evict_until("cuda:0", "qwen", lambda: None))

        await asyncio.sleep(0.15)
        assert entry.is_set(), "the step never entered — test would pass vacuously"
        assert len(ticks) >= 3, (
            f"heartbeat only ticked {len(ticks)} times in 150ms while the evict "
            "step was parked — the event loop stalled"
        )

        release.set()
        await evict_task
        hb_task.cancel()
        try:
            await hb_task
        except asyncio.CancelledError:
            pass

    asyncio.run(body())


def test_the_post_evict_reclaim_does_not_stall_the_event_loop(monkeypatch):
    """T3: the reclaim (`_reclaim_after_drop`'s `gc.collect()` +
    `empty_cache()`) must ALSO run off the loop, not just the lock wait — it
    is the correction #1919's issue calls out and rev 1 of this plan missed.
    Uses a REAL `CoquiEngine.maybe_free_idle`, driven through the REAL
    `PlacementController._evict_until` (not a fake EvictStep), with
    `_reclaim_after_drop` monkeypatched to block on an Event standing in for
    a multi-GB `gc.collect()`/`empty_cache()`.

    Mutation-fails against the 'half fix' — offloading only the lock's wait
    and leaving the drop + reclaim synchronous on the loop: that passes T2's
    test (a monolithic fake step can't distinguish a partial fix) but fails
    this one, because the real reclaim is what's parked here. In practice
    (see the report) the only mutation constructible against this codebase's
    opaque `EvictStep.run` interface is the full T2 revert, which this test
    also fails against, for the same reason."""
    eng = main.CoquiEngine()
    monkeypatch.setattr(eng, "_ensure_loaded", lambda model, device=None, *, lock_held=False: None)
    eng._tts = object()  # any non-None sentinel — maybe_free_idle only checks identity
    eng._resolved_device = "cuda:0"
    eng._device = "cuda:0"
    eng._last_used = time.monotonic() - 3600  # long idle, clears the TTL guard

    entry = threading.Event()
    release = threading.Event()

    def blocking_reclaim(torch_module, reason="unloaded"):
        entry.set()
        release.wait(timeout=1.0)

    monkeypatch.setattr(eng, "_reclaim_after_drop", blocking_reclaim)

    async def body():
        ticks: list[int] = []

        async def heartbeat():
            while True:
                ticks.append(1)
                await asyncio.sleep(0.01)

        hb_task = asyncio.create_task(heartbeat())
        pc = make(
            [dev(free=500, total=8192)],
            peak=3000,
            idle_evict_steps=lambda dk, eng_id: [
                main.EvictStep("coqui", "coqui", lambda: eng.maybe_free_idle(0.0))
            ],
        )
        evict_task = asyncio.create_task(pc._evict_until("cuda:0", "qwen", lambda: None))

        await asyncio.sleep(0.15)
        assert entry.is_set(), "the reclaim never entered — test would pass vacuously"
        assert len(ticks) >= 3, (
            f"heartbeat only ticked {len(ticks)} times while the reclaim was parked"
        )

        release.set()
        await evict_task
        hb_task.cancel()
        try:
            await hb_task
        except asyncio.CancelledError:
            pass

    asyncio.run(body())
    assert eng._tts is None  # maybe_free_idle's contract ("True iff it actually freed") held


def test_a_qwen_eviction_step_does_not_stall_the_event_loop():
    """T3: the Qwen twin — Qwen carries `reserved_key=None` (#1920B can never
    protect it, §1.1) and is the default GPU engine, so its two steps are the
    LEAST protected of the five. `maybe_free_idle_design`'s fast-out checks
    only `_design_in_flight`, not the Base forward, so with VoiceDesign warm
    and a Base forward in flight the step reaches `_synth_lock` and blocks —
    the #1919 race, reached on the default path. A separate thread holds
    `_synth_lock` here, standing in for that in-flight Base forward."""
    eng = main.QwenEngine()
    eng._design = object()  # a resident VoiceDesign
    eng._design_last_used = time.monotonic() - 3600  # long idle

    lock_acquired = threading.Event()
    release = threading.Event()

    def hold_lock():
        eng._synth_lock.acquire()
        lock_acquired.set()
        release.wait(timeout=1.0)
        eng._synth_lock.release()

    holder = threading.Thread(target=hold_lock)
    holder.start()
    assert lock_acquired.wait(timeout=5), "holder thread never acquired _synth_lock"

    async def body():
        ticks: list[int] = []

        async def heartbeat():
            while True:
                ticks.append(1)
                await asyncio.sleep(0.01)

        hb_task = asyncio.create_task(heartbeat())
        pc = make(
            [dev(free=500, total=8192)],
            peak=3000,
            idle_evict_steps=lambda dk, eng_id: [
                main.EvictStep("qwen.design", None, lambda: eng.maybe_free_idle_design(0.0))
            ],
        )
        evict_task = asyncio.create_task(pc._evict_until("cuda:0", "qwen", lambda: None))

        await asyncio.sleep(0.15)
        assert len(ticks) >= 3, (
            f"heartbeat only ticked {len(ticks)} times while queued on _synth_lock"
        )

        release.set()
        await evict_task
        hb_task.cancel()
        try:
            await hb_task
        except asyncio.CancelledError:
            pass

    asyncio.run(body())
    holder.join(timeout=5)
    assert eng._design is None  # the fast-out passed, then the step still froze it


def test_try_hold_is_atomic_under_concurrency():
    """The decide+hold must be atomic: N threads racing to reserve a device
    that fits only ONE peak must grant exactly one — proving the ledger's
    single-lock try_hold blocks the TOCTOU double-book (two ops both passing
    the fit-check then both holding) that peak-reservation exists to prevent."""
    import threading

    ledger = main.ReservationLedger()
    # 8192 - 5600 = 2592 < 5600, so a device holding one 5600 peak cannot fit a
    # second — with a correct atomic check exactly one of the racers wins.
    candidates = [("cuda:0", 8000, 8192)]
    granted: list[tuple[str, int]] = []
    lock = threading.Lock()
    barrier = threading.Barrier(16)

    def worker():
        barrier.wait()  # release all 16 at once to maximise the race
        tok = ledger.try_hold(candidates, 5600, 768, "qwen")
        if tok is not None:
            with lock:
                granted.append(tok)

    threads = [threading.Thread(target=worker) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(granted) == 1, f"expected exactly one atomic grant, got {len(granted)}"
    # The no-OOM invariant: Σ held ≤ total − per-device reserve (min(5% of
    # this 8192 MB card, the 768 cap) = 410).
    assert ledger.reserved_mb("cuda:0") == 5600
    assert ledger.reserved_mb("cuda:0") <= 8192 - main._device_reserve_mb(8192, 768)


def test_resident_device_still_fit_checked():
    """A resident model is NOT a free pass: if its device can't fit the op's
    decode peak (e.g. an analyzer grew into that VRAM after the model loaded),
    admit must return noCapacity — not admit onto a full device and OOM."""
    devices = [dev(index=0, free=1000, total=8192)]  # resident device is nearly full
    pc = make(devices, peak=5600, resident=lambda e: "cuda:0")
    a = pc.admit("qwen", "q", {}, cpu_capable=False, heavy=True)
    assert "noCapacity" in a and a["noCapacity"]["deviceKey"] == "cuda:0"


def test_resident_no_fit_reports_resident_device_not_roomier_one():
    """Multi-GPU: a resident engine that can't fit its pinned device must report
    THAT device as deviceKey (where Node should evict), NOT a roomier
    non-resident GPU where an evict can't help — the model can't migrate."""
    devices = [dev(index=0, free=1000, total=8192), dev(index=1, free=15000, total=16384)]
    pc = make(devices, peak=5600, resident=lambda e: "cuda:0")
    a = pc.admit("qwen", "q", {}, cpu_capable=False, heavy=True)
    assert "noCapacity" in a and a["noCapacity"]["deviceKey"] == "cuda:0"


def test_resident_device_admits_when_peak_fits():
    devices = [dev(index=0, free=8000, total=8192)]
    pc = make(devices, peak=5600, resident=lambda e: "cuda:0")
    assert pc.admit("qwen", "q", {}, cpu_capable=False, heavy=True)["device"] == "cuda:0"


def test_resident_reservation_holds_on_its_device():
    """reservation() on a resident engine holds the peak on that exact device
    and releases on exit."""
    devices = [dev(index=0, free=8000, total=8192)]
    ledger = main.ReservationLedger()
    fp = type("F", (), {"peak_mb": lambda *_: 5600, "record": lambda *_: None})()
    pc = main.PlacementController(
        probe=lambda: devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict_steps=lambda dk, eng: [],
        is_resident=lambda e: "cuda:0",
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as a:
        assert a["device"] == "cuda:0"
        assert ledger.reserved_mb("cuda:0") == 5600
    assert ledger.reserved_mb("cuda:0") == 0  # released on exit


def test_pinned_restricts_candidates_to_one_device():
    """Two roomy GPUs; pinning to cuda:1 must restrict candidates to exactly
    that device, even though cuda:0 is equally (or more) roomy."""
    devices = [dev(index=0, free=20000, total=24000), dev(index=1, free=20000, total=24000)]
    pc = make(devices, peak=5600)
    adm = pc.admit("coqui", "xtts_v2", {}, cpu_capable=False, heavy=True, pinned="cuda:1")
    assert adm == {"device": "cuda:1"}


def test_pinned_full_card_yields_nocapacity_even_with_room_elsewhere():
    """A pinned op whose pinned device can't fit must report noCapacity with
    THAT device as deviceKey — not the roomier cuda:0 — so Node evicts from
    the pinned card, not wherever has the most headroom."""
    devices = [dev(index=0, free=20000, total=24000), dev(index=1, free=500, total=24000)]
    pc = make(devices, peak=5600)
    adm = pc.admit("coqui", "xtts_v2", {}, cpu_capable=False, heavy=True, pinned="cuda:1")
    assert "noCapacity" in adm and adm["noCapacity"]["deviceKey"] == "cuda:1"


# --- _engine_env_pin ------------------------------------------------------
#
# `_engine_env_pin` is the seam PlacementController's callers use to derive
# `pinned=` above from an engine's *_DEVICE env knob: a concrete "cuda:N" key
# when the knob names an indexed CUDA device, else None (auto/unset/cpu/mps/
# malformed index) so admission falls back to picking the roomiest device.


def test_engine_env_pin_unknown_engine_returns_none(monkeypatch):
    monkeypatch.setenv("COQUI_DEVICE", "cuda:1")  # present but irrelevant — wrong engine id
    assert main._engine_env_pin("nope") is None


@pytest.mark.parametrize(
    "env_var,engine_id",
    [
        ("COQUI_DEVICE", "coqui"),
        ("KOKORO_DEVICE", "kokoro"),
        ("QWEN_DEVICE", "qwen"),
        ("ASR_DEVICE", "asr"),
        ("SPK_DEVICE", "spk"),
    ],
)
def test_engine_env_pin_unset_returns_none(monkeypatch, env_var, engine_id):
    monkeypatch.delenv(env_var, raising=False)
    assert main._engine_env_pin(engine_id) is None


def test_engine_env_pin_cpu_returns_none(monkeypatch):
    monkeypatch.setenv("QWEN_DEVICE", "cpu")
    assert main._engine_env_pin("qwen") is None


def test_engine_env_pin_indexed_cuda_returns_concrete_key(monkeypatch):
    monkeypatch.setenv("QWEN_DEVICE", "cuda:1")
    assert main._engine_env_pin("qwen") == "cuda:1"


def test_engine_env_pin_cuda_without_index_returns_none(monkeypatch):
    monkeypatch.setenv("QWEN_DEVICE", "cuda")
    assert main._engine_env_pin("qwen") is None


# --- engine attribution on the reservation ledger (#1920B) ------------------


def test_ledger_reports_which_engines_hold_a_device():
    """Fails against the wrong implementation: a ledger that stores only
    (token -> mb) has no engine to report, so this cannot even be written."""
    ledger = main.ReservationLedger()
    a = ledger.hold("cuda:0", 3000, "coqui")
    ledger.hold("cuda:0", 400, "asr")
    ledger.hold("cuda:1", 6000, "qwen")
    assert ledger.engines_holding("cuda:0") == {"coqui", "asr"}
    assert ledger.engines_holding("cuda:1") == {"qwen"}
    ledger.release(a)
    assert ledger.engines_holding("cuda:0") == {"asr"}
    assert ledger.engines_holding("cuda:2") == set()


def test_try_hold_records_the_admitting_engine():
    ledger = main.ReservationLedger()
    tok = ledger.try_hold([("cuda:0", 8000, 8000)], 3000, 768, "coqui")
    assert tok is not None
    assert ledger.engines_holding("cuda:0") == {"coqui"}
