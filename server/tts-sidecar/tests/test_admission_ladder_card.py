"""#4164 — on a multi-GPU box the idle-evict LADDER must run against the card the
op is restricted to (resident there, or pinned there but not yet loaded), not
against the roomiest card. Both entry points are exercised: `admit()` and
`reservation()` (-> `_resolve_admission`). The refusal and reclaim keys already
honoured resident/pinned; only the ladder target was wrong."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

PEAK = 6000


def _devs():
    # cuda:0 is TIGHT (cannot fit PEAK + reserve even after the cushion);
    # cuda:1 is the roomy card `_worst_device_key` picks.
    return [
        {"kind": "cuda", "index": 0, "label": "laptop", "totalMb": 8192, "freeMb": 900},
        {"kind": "cuda", "index": 1, "label": "egpu", "totalMb": 12288, "freeMb": 9000},
    ]


def _make(devs, seen, resident=None):
    fp = type("F", (), {"peak_mb": lambda *_: PEAK, "record": lambda *_: None})()

    def steps(dk, eng):
        seen.append(dk)
        return []

    return main.PlacementController(
        probe=lambda: devs,
        footprints=fp,
        ledger=main.ReservationLedger(),
        reserve_mb=lambda: 500,
        idle_evict_steps=steps,
        is_resident=resident or (lambda e: None),
        reclaim=lambda dk: False,
    )


def _run_both(devs, resident=None, pinned=None):
    """Run reservation() then admit() on fresh controllers; return the device
    keys the ladder was run against for each."""
    out = {}

    seen = []
    pc = _make(devs, seen, resident)

    async def once():
        async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True, pinned=pinned) as adm:
            return adm

    asyncio.run(once())
    out["reservation"] = list(seen)

    seen2 = []
    pc2 = _make(devs, seen2, resident)
    asyncio.run(pc2.admit("coqui", None, {}, cpu_capable=False, heavy=True, pinned=pinned))
    out["admit"] = list(seen2)
    return out


def test_resident_op_ladder_runs_only_on_its_own_tight_card():
    out = _run_both(_devs(), resident=lambda e: "cuda:0")
    for entry, seen in out.items():
        assert seen and set(seen) == {"cuda:0"}, f"{entry}: ladder ran on {seen}"
        assert "cuda:1" not in seen


def test_pinned_not_resident_op_ladder_runs_only_on_the_pinned_card():
    out = _run_both(_devs(), pinned="cuda:0")
    for entry, seen in out.items():
        assert seen and set(seen) == {"cuda:0"}, f"{entry}: ladder ran on {seen}"
        assert "cuda:1" not in seen


def test_no_constraint_ladder_still_targets_the_roomiest_card():
    # Control: both cards too tight, nothing resident or pinned -> the
    # fallback (`_worst_device_key`, the roomiest) is intact.
    devs = [
        {"kind": "cuda", "index": 0, "label": "a", "totalMb": 8192, "freeMb": 900},
        {"kind": "cuda", "index": 1, "label": "b", "totalMb": 8192, "freeMb": 2000},
    ]
    out = _run_both(devs)
    for entry, seen in out.items():
        assert seen and set(seen) == {"cuda:1"}, f"{entry}: ladder ran on {seen}"
