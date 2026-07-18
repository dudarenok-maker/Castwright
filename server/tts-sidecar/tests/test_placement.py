"""Tests for `ReservationLedger` + `PlacementController` — the core
peak-reservation admission logic of capacity-aware GPU placement (task 3 of
the vram-aware-placement plan).

Contract pinned here: `admit()` reserves the FootprintTable's peak-mb
estimate for the winning device so a second concurrent op can't double-book
VRAM the first one already claimed; `reservation()` releases that hold (and
records the observed peak) on exit, whether the op succeeded or raised."""
from __future__ import annotations

import sys
from pathlib import Path

# Add the sidecar root to sys.path so `import main` works regardless of
# pytest's collection directory — same pattern as test_capacity.py.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def dev(kind="cuda", index=0, total=8192, free=8000):
    return {"kind": kind, "index": index, "label": "g", "totalMb": total, "freeMb": free}


def make(devices, peak, reserve=768, idle_evict=None, resident=None):
    fp = type("F", (), {"peak_mb": lambda *_: peak, "record": lambda *_: None})()
    return main.PlacementController(
        probe=lambda: devices,
        footprints=fp,
        ledger=main.ReservationLedger(),
        reserve_mb=lambda: reserve,
        idle_evict=idle_evict or (lambda dk: False),
        is_resident=resident or (lambda e: None),
    )


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
    ledger = main.ReservationLedger()
    tok = ledger.hold("cuda:0", 6000)
    fp = type("F", (), {"peak_mb": lambda *_: 5600, "record": lambda *_: None})()
    pc = main.PlacementController(
        probe=lambda: devices,
        footprints=fp,
        ledger=ledger,
        reserve_mb=lambda: 768,
        idle_evict=lambda dk: (ledger.release(tok) or True),
        is_resident=lambda e: None,
    )
    assert pc.admit("qwen", "q", {}, False, True)["device"] == "cuda:0"


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
        tok = ledger.try_hold(candidates, 5600, 768)
        if tok is not None:
            with lock:
                granted.append(tok)

    threads = [threading.Thread(target=worker) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(granted) == 1, f"expected exactly one atomic grant, got {len(granted)}"
    # The no-OOM invariant: Σ held ≤ total − reserve.
    assert ledger.reserved_mb("cuda:0") == 5600
    assert ledger.reserved_mb("cuda:0") <= 8192 - 768


def test_resident_device_still_fit_checked():
    """A resident model is NOT a free pass: if its device can't fit the op's
    decode peak (e.g. an analyzer grew into that VRAM after the model loaded),
    admit must return noCapacity — not admit onto a full device and OOM."""
    devices = [dev(index=0, free=1000, total=8192)]  # resident device is nearly full
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
        idle_evict=lambda dk: False,
        is_resident=lambda e: "cuda:0",
    )
    with pc.reservation("qwen", "q", {}, cpu_capable=False, heavy=True) as a:
        assert a["device"] == "cuda:0"
        assert ledger.reserved_mb("cuda:0") == 5600
    assert ledger.reserved_mb("cuda:0") == 0  # released on exit
