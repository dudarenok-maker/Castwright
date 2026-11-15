"""#4102 — a resident GPU ASR (Whisper) model must not be evicted by the
admission of the very `/transcribe` request that is about to use it, and the
ladder / reclaim / refusal must target the card the model is on. The protection
goes through the #4079 hook `_own_resident_tier`; the warm booking is the
existing `asr.warm` (128 MB). These tests drive the PRODUCTION `main._placement`
(real hook, real ladder, real FootprintTable) with fake engines and a fake
probe whose free memory rises when a fake is evicted."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

TOTAL = 8192  # cushion 409


class FakeEngine:
    def __init__(self, card, mb, resident=True):
        self._device = card
        self.device = card
        self.resident = resident
        self.mb = mb
        self.evictions = 0

    def maybe_free_idle(self, ttl):
        was = self.resident
        self.resident = False
        if was:
            self.evictions += 1
        return was


def _wire(monkeypatch, asr, spk, base_free):
    """`base_free` maps card index -> free MB with NO fake resident on it."""
    fakes = {"asr": asr, "spk": spk}
    monkeypatch.setattr(main, "ASR", asr)
    monkeypatch.setattr(main, "SPK", spk if spk is not None else object())
    monkeypatch.delitem(main.ENGINES, "qwen", raising=False)
    monkeypatch.delitem(main.ENGINES, "coqui", raising=False)
    monkeypatch.setattr(main, "_reclaim_host_and_vram", lambda: None)

    def resident_card(engine_id):
        f = fakes.get(engine_id)
        return f._device if f is not None and f.resident else None

    monkeypatch.setattr(main, "_is_resident", resident_card)

    def probe():
        out = []
        for idx, base in base_free.items():
            card = f"cuda:{idx}"
            used = sum(f.mb for f in (asr, spk) if f is not None and f.resident and f._device == card)
            out.append({"kind": "cuda", "index": idx, "label": "g", "totalMb": TOTAL, "freeMb": base - used})
        return out

    pc = main._placement
    monkeypatch.setattr(pc, "is_resident", resident_card)
    monkeypatch.setattr(pc, "probe", probe)
    monkeypatch.setattr(pc, "footprints", main.FootprintTable())
    monkeypatch.setattr(pc, "ledger", main.ReservationLedger())
    monkeypatch.setattr(pc, "reserve_mb", lambda: 500)
    monkeypatch.setattr(pc, "_protected_steps", {}, raising=False)
    monkeypatch.setattr(pc, "_admit_lock", asyncio.Lock())
    monkeypatch.setattr(pc, "reclaim", lambda dk: False)
    monkeypatch.setattr(pc, "_last_reclaim", {})
    return pc


def _admit(pc):
    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False) as adm:
            return adm, pc.ledger.reserved_mb("cuda:0")

    return asyncio.run(body())


def test_a1_resident_asr_is_protected_when_warm_booking_does_not_fit(monkeypatch):
    asr = FakeEngine("cuda:0", 400)
    pc = _wire(monkeypatch, asr, None, {0: 850})  # free 450 with ASR loaded
    adm, _ = _admit(pc)
    assert adm == {"noCapacity": {"neededMb": 128, "deviceKey": "cuda:0"}}
    assert asr.evictions == 0


def test_a2_resident_asr_books_only_the_warm_amount(monkeypatch):
    asr = FakeEngine("cuda:0", 400)
    pc = _wire(monkeypatch, asr, None, {0: 2400})  # free 2000 with ASR loaded
    adm, booked = _admit(pc)
    assert adm == {"device": "cuda:0"}
    assert booked == 128
    assert asr.evictions == 0


def test_a3_other_models_still_make_room_but_asr_is_kept(monkeypatch):
    asr = FakeEngine("cuda:0", 400)
    spk = FakeEngine("cuda:0", 300)
    pc = _wire(monkeypatch, asr, spk, {0: 1150})  # free 450 with both loaded
    adm, _ = _admit(pc)
    assert adm == {"device": "cuda:0"}
    assert spk.evictions == 1
    assert asr.evictions == 0


def test_a4_ladder_targets_the_card_asr_is_resident_on(monkeypatch):
    asr = FakeEngine("cuda:1", 400)
    spk = FakeEngine("cuda:1", 300)
    pc = _wire(monkeypatch, asr, spk, {0: 6000, 1: 1150})  # cuda:1 free 450
    async def body():
        async with pc.reservation("asr", None, {}, cpu_capable=False, heavy=False) as adm:
            return adm

    assert asyncio.run(body()) == {"device": "cuda:1"}
    assert spk.evictions == 1
    assert asr.evictions == 0


def test_a5_cold_asr_is_unchanged(monkeypatch):
    asr = FakeEngine("cuda:0", 400, resident=False)
    pc = _wire(monkeypatch, asr, None, {0: 6000})
    assert main._own_resident_tier("asr", None, {}) == (None, 0, None)
    adm, booked = _admit(pc)
    assert adm == {"device": "cuda:0"}
    assert booked == 400


def test_a6_resolver_returns_the_resident_card_with_no_credit(monkeypatch):
    asr = FakeEngine("cuda:0", 400)
    _wire(monkeypatch, asr, None, {0: 6000})
    assert main._own_resident_tier("asr", None, {}) == ("asr", 0, "cuda:0")


# --- GPU SPK (ECAPA) -------------------------------------------------------


def _admit_spk(pc):
    async def body():
        async with pc.reservation("spk", None, {}, cpu_capable=False, heavy=False) as adm:
            return adm

    return asyncio.run(body())


def _spk_peak(pc):
    return pc.footprints.peak_mb("spk", None, {}, True)


def test_s1_resident_spk_is_protected_when_its_booking_does_not_fit(monkeypatch):
    spk = FakeEngine("cuda:0", 300)
    pc = _wire(monkeypatch, None, spk, {0: 750})  # free 450 with SPK loaded
    adm = _admit_spk(pc)
    assert adm == {"noCapacity": {"neededMb": _spk_peak(pc), "deviceKey": "cuda:0"}}
    assert spk.evictions == 0


def test_s2_other_models_still_make_room_but_spk_is_kept(monkeypatch):
    asr = FakeEngine("cuda:0", 400)
    spk = FakeEngine("cuda:0", 300)
    pc = _wire(monkeypatch, asr, spk, {0: 1150})  # free 450 with both loaded
    adm = _admit_spk(pc)
    assert adm == {"device": "cuda:0"}
    assert asr.evictions == 1
    assert spk.evictions == 0


def test_s3_ladder_targets_the_card_spk_is_resident_on(monkeypatch):
    asr = FakeEngine("cuda:1", 400)
    spk = FakeEngine("cuda:1", 300)
    pc = _wire(monkeypatch, asr, spk, {0: 6000, 1: 1150})  # cuda:1 free 450
    assert _admit_spk(pc) == {"device": "cuda:1"}
    assert asr.evictions == 1
    assert spk.evictions == 0


def test_s4_spk_resolver_returns_the_resident_card_with_no_credit(monkeypatch):
    spk = FakeEngine("cuda:0", 300)
    _wire(monkeypatch, None, spk, {0: 6000})
    assert main._own_resident_tier("spk", None, {}) == ("spk", 0, "cuda:0")
    spk.resident = False
    assert main._own_resident_tier("spk", None, {}) == (None, 0, None)


def _idle_asr():
    # `FootprintTable.snapshot()` reads `ASR._model_name`; keep a non-resident stand-in.
    asr = FakeEngine("cuda:0", 400, resident=False)
    asr._model_name = "base"
    return asr


def test_s5_resident_spk_observation_is_not_learned(monkeypatch):
    # #4102: a resident SPK op's torch-allocator peak already includes the
    # resident ECAPA weights, so recording it would drag "spk.warm" back up.
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 500))
    spk = FakeEngine("cuda:0", 300)
    pc = _wire(monkeypatch, _idle_asr(), spk, {0: 6000})
    assert _admit_spk(pc) == {"device": "cuda:0"}
    assert pc.footprints.snapshot()["spk.warm"]["sample_count"] == 0


def test_s6_cold_spk_observation_is_still_learned(monkeypatch):
    monkeypatch.setattr(main.PlacementController, "_observed_mb", staticmethod(lambda device_key: 500))
    spk = FakeEngine("cuda:0", 300, resident=False)
    pc = _wire(monkeypatch, _idle_asr(), spk, {0: 6000})
    assert _admit_spk(pc) == {"device": "cuda:0"}
    assert pc.footprints.snapshot()["spk"]["sample_count"] == 1
