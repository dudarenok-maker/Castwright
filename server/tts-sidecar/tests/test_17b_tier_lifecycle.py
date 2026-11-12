"""#4079 — the 1.7B-Base tier must not be evicted by the admission of the very
request that is about to use it (A122 Finding 1 / A120 F9), the ledger must keep
booking the FULL peak, and an admission evict must not be logged as the idle
watchdog. Most tests drive the REAL `_own_resident_tier` + `_idle_evict_steps`
through `PlacementController.reservation` with a fake resident QwenEngine, so
they go red on `main` because base17 is evicted, not because an API is missing."""
from __future__ import annotations

import asyncio
import logging
import sys
import threading
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

TOTAL = 8192
BASE17_MB = 3900  # measured on-box (A122 tts.err.log: vram_reserved 3951/4048 with base17 resident)
OTHER_MB = 300  # CUDA context etc.


def _fake_qwen(resident=True, weights_mb=0, device="cuda:0"):
    q = object.__new__(main.QwenEngine)
    q._base = None
    q._base17 = object() if resident else None
    q._design = None
    q._base17_last_used = 0.0
    q._base17_in_flight = main.InFlightCounter()
    q._design_in_flight = main.InFlightCounter()
    q._synth_lock = threading.Lock()
    q._device = device
    q._base17_weights_mb = weights_mb
    return q


class FP:
    """Footprints at the seeds (cold 1.7b = 6144), no learning."""

    def __init__(self, peaks=None):
        self.peaks = peaks or {"qwen.1.7b": 6144, "qwen": 3072, "coqui": 3584}

    def peak_mb(self, engine, model, cfg=None, resident=False):
        return self.peaks.get(main.FootprintTable._key(engine, model, cfg, resident), 0)

    def record(self, *a, **k):
        pass


def _wire(monkeypatch, qwen, devices_fn, steps=None):
    monkeypatch.setitem(main.ENGINES, "qwen", qwen)
    monkeypatch.delitem(main.ENGINES, "coqui", raising=False)
    monkeypatch.setattr(main, "_reclaim_host_and_vram", lambda: None)
    monkeypatch.setattr(main, "SPK", object())
    monkeypatch.setattr(main, "ASR", object())
    # The PRODUCTION controller (real own_resident_tier hook, real ladder, real
    # _is_resident, which is blind to _base17); only the probe/footprints/ledger
    # are swapped. This is what makes the tests red on `main` by eviction, and
    # what catches the hook being unwired from `_placement`.
    pc = main._placement
    monkeypatch.setattr(pc, "probe", devices_fn)
    monkeypatch.setattr(pc, "footprints", FP())
    monkeypatch.setattr(pc, "ledger", main.ReservationLedger())
    monkeypatch.setattr(pc, "reserve_mb", lambda: 500)
    monkeypatch.setattr(pc, "_protected_steps", {}, raising=False)
    monkeypatch.setattr(pc, "_admit_lock", asyncio.Lock())
    reclaims: list = []
    monkeypatch.setattr(pc, "reclaim", lambda dk: reclaims.append(dk) or False)
    monkeypatch.setattr(pc, "_last_reclaim", {})  # the per-device reclaim cooldown is production state
    monkeypatch.setattr(pc, "_test_reclaims", reclaims, raising=False)
    if steps is not None:
        monkeypatch.setattr(pc, "idle_evict_steps", steps)
    return pc


def _one_card(qwen, extra_free=0):
    def probe():
        used = OTHER_MB + (BASE17_MB if qwen._base17 is not None else 0)
        return [{"kind": "cuda", "index": 0, "label": "g", "totalMb": TOTAL, "freeMb": TOTAL - used + extra_free}]

    return probe


# --- the headline: real wiring, real ladder -------------------------------


def test_resident_1_7b_synth_is_admitted_without_evicting_base17(monkeypatch):
    """F9: back-to-back 1.7b synth on 8 GB. On main this evicts base17 (the
    cold 6144 booking does not fit next to the resident 3900)."""
    qwen = _fake_qwen()
    pc = _wire(monkeypatch, qwen, _one_card(qwen))

    async def body():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
            return adm, pc.ledger.reserved_mb("cuda:0")

    adm, booked = asyncio.run(body())
    assert adm == {"device": "cuda:0"}
    assert qwen._base17 is not None, "admission evicted the tier the request is about to use"
    assert booked == 6144, "the ledger must book the FULL peak"


def test_cold_1_7b_synth_with_nothing_resident_still_admits_normally(monkeypatch):
    qwen = _fake_qwen(resident=False)
    pc = _wire(monkeypatch, qwen, _one_card(qwen))

    async def body():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
            return adm

    assert asyncio.run(body()) == {"device": "cuda:0"}


def test_protected_tier_is_not_evicted_even_when_nothing_fits(monkeypatch):
    qwen = _fake_qwen()
    # Another process holds most of the card: even with the credit it cannot fit.
    pc = _wire(monkeypatch, qwen, _one_card(qwen, extra_free=-3000))

    async def body():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
            return adm

    assert "noCapacity" in asyncio.run(body())
    assert qwen._base17 is not None


def test_admit_skips_the_protected_tier_without_relying_on_the_credit(monkeypatch):
    """Kills the 'protect removed from admit()' mutant: a probe that only fits
    AFTER base17 is gone, so only a (wrongly) run evict step could admit."""
    qwen = _fake_qwen()
    ran = []

    def steps(dk, eng):
        def run():
            ran.append("qwen.base17")
            return True

        return [main.EvictStep("qwen.base17", None, run)]

    def probe():  # fits only if base17 is evicted AND not credited: too tight for the credit
        return [{"kind": "cuda", "index": 0, "label": "g", "totalMb": TOTAL, "freeMb": 100}]

    pc = _wire(monkeypatch, qwen, probe, steps=steps)
    out = asyncio.run(pc.admit("qwen", "1.7b", {}, cpu_capable=False, heavy=True))
    assert "noCapacity" in out
    assert ran == [], "admit() ran the protected evict step"


# --- 🟠1 (a)/(b)/(c): the ledger ------------------------------------------


def test_a_second_op_is_not_admitted_into_vram_the_first_booked(monkeypatch):
    """(a) On the credited-booking design B (3072) was admitted next to A's
    2744 hold: 5816 booked against 3992 free."""
    qwen = _fake_qwen()
    pc = _wire(monkeypatch, qwen, _one_card(qwen))
    out = {}

    async def body():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as a:
            out["a"] = a
            async with pc.reservation("qwen", "0.6b", {}, cpu_capable=False, heavy=True) as b:
                out["b"] = b

    asyncio.run(body())
    assert out["a"] == {"device": "cuda:0"}
    assert "noCapacity" in out["b"]


def test_another_admissions_ladder_cannot_evict_base17_under_the_hold(monkeypatch):
    """(b) A holds its booking but has not claimed _base17_in_flight; a Coqui
    admission's ladder used to run the real qwen.base17 step."""
    qwen = _fake_qwen()
    # Roomy enough for Coqui to be admitted only after evicting something.
    pc = _wire(monkeypatch, qwen, _one_card(qwen))
    out = {}

    async def body():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True):
            async with pc.reservation("coqui", None, {}, cpu_capable=False, heavy=True) as b:
                out["b"] = b
                out["during"] = qwen._base17
        out["protected_after"] = dict(pc._protected_steps)

    asyncio.run(body())
    assert out["during"] is not None
    assert "noCapacity" in out["b"]
    assert out["protected_after"].get("qwen.base17", 0) == 0, "protection must be released with the hold"


def test_protection_is_released_when_the_body_raises(monkeypatch):
    qwen = _fake_qwen()
    pc = _wire(monkeypatch, qwen, _one_card(qwen))

    async def body():
        with pytest.raises(RuntimeError):
            async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True):
                raise RuntimeError("boom")

    asyncio.run(body())
    assert pc._protected_steps.get("qwen.base17", 0) == 0


def test_the_credit_lands_only_on_the_card_base17_is_on(monkeypatch):
    """(c) cuda:0 (base17 resident) cannot fit; cuda:1 (eGPU) has room. The
    forward runs on cuda:0 regardless, so the request must not be 'placed' on
    cuda:1 against a booking that never covers cuda:0."""
    qwen = _fake_qwen()
    devs = [
        {"kind": "cuda", "index": 0, "label": "laptop", "totalMb": 8192, "freeMb": 3992},
        {"kind": "cuda", "index": 1, "label": "egpu", "totalMb": 12288, "freeMb": 9000},
    ]
    pc = _wire(monkeypatch, qwen, lambda: devs, steps=lambda dk, eng: [])
    out = {}

    async def body():
        assert main._is_resident("qwen") is None
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as a:
            out["a"] = a
            out["held"] = (pc.ledger.reserved_mb("cuda:0"), pc.ledger.reserved_mb("cuda:1"))

    asyncio.run(body())
    assert out["a"] == {"device": "cuda:0"}
    assert out["held"] == (6144, 0)


# --- the resolver ---------------------------------------------------------


def test_own_resident_tier_resolver(monkeypatch):
    monkeypatch.setitem(main.ENGINES, "qwen", _fake_qwen(True, weights_mb=3900))
    assert main._own_resident_tier("qwen", "1.7b", {}) == ("qwen.base17", 3900, "cuda:0")
    assert main._own_resident_tier("qwen", "1.7b", None)[0] == "qwen.base17"
    assert main._own_resident_tier("qwen", "0.6b", {}) == (None, 0, None)
    assert main._own_resident_tier("qwen", None, {}) == (None, 0, None)
    assert main._own_resident_tier("qwen", "1.7b", {"op": "design"}) == (None, 0, None)
    assert main._own_resident_tier("qwen", "1.7b", {"op": "mint"}) == (None, 0, None)
    assert main._own_resident_tier("coqui", "1.7b", {}) == (None, 0, None)
    monkeypatch.setitem(main.ENGINES, "qwen", _fake_qwen(False))
    assert main._own_resident_tier("qwen", "1.7b", {}) == (None, 0, None)
    only06 = _fake_qwen(False)
    only06._base = object()  # Qwen is on a card, but the 1.7B-Base is not loaded
    monkeypatch.setitem(main.ENGINES, "qwen", only06)
    assert main._own_resident_tier("qwen", "1.7b", {}) == (None, 0, None)


def test_credit_size_is_the_measured_footprint_and_never_zero(monkeypatch):
    monkeypatch.setitem(main.ENGINES, "qwen", _fake_qwen(True, weights_mb=3900))
    assert main._own_resident_tier("qwen", "1.7b", {})[1] == 3900
    monkeypatch.setitem(main.ENGINES, "qwen", _fake_qwen(True, weights_mb=0))
    assert main._own_resident_tier("qwen", "1.7b", {})[1] == main._QWEN_BASE17_WEIGHTS_MB > 0


def test_credit_size_drives_the_decision(monkeypatch):
    """A measured footprint larger than the constant must admit what the
    constant would refuse (and vice versa), proving the number is used."""
    free_with_resident = 2400  # + 3900 credit = 6300 >= 6144 + cushion 409? 6300 < 6553: tight
    for weights, expect_ok in ((3900 + 500, True), (3400 - 1000, False)):
        qwen = _fake_qwen(True, weights_mb=weights)
        monkeypatch.setitem(main.ENGINES, "qwen", qwen)
        pc = _wire(monkeypatch, qwen, lambda: [
            {"kind": "cuda", "index": 0, "label": "g", "totalMb": TOTAL, "freeMb": free_with_resident}
        ])

        async def body():
            async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
                return adm

        assert ("noCapacity" not in asyncio.run(body())) is expect_ok


def test_base17_weights_are_measured_at_load(monkeypatch):
    """Parameter + buffer bytes of the loaded model, in MB. No torch needed (CI's
    lean sidecar install has none): `torch` is stubbed in sys.modules."""
    import types

    class T:
        def __init__(self, mb):
            self._n = mb * 1_048_576

        def numel(self):
            return self._n // 2

        def element_size(self):
            return 2

    class FakeModel:
        def parameters(self):
            return [T(3000), T(700)]

        def buffers(self):
            return [T(200)]

    loaded = types.SimpleNamespace(model=FakeModel())
    q = _fake_qwen(resident=False)
    q._cold_load_lock = threading.Lock()
    q._device_pref = "cuda:0"
    q._ensure_device_resolved = lambda: None
    monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))
    monkeypatch.setattr(q, "_load_qwen_model", lambda name: loaded, raising=False)
    monkeypatch.setattr(main, "_install_codec_timing", lambda m: None)
    monkeypatch.setattr(main, "_maybe_compile_codec", lambda m, t: None)
    q._ensure_base17_loaded()
    assert q._base17_weights_mb == 3900


def test_unreadable_model_measures_zero_and_falls_back_to_the_constant(monkeypatch):
    assert main._module_weights_mb(object()) == 0
    monkeypatch.setitem(main.ENGINES, "qwen", _fake_qwen(True, weights_mb=0))
    assert main._own_resident_tier("qwen", "1.7b", {})[1] == main._QWEN_BASE17_WEIGHTS_MB


# --- log text -------------------------------------------------------------


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


# --- the render lease -----------------------------------------------------


def _run_one_watchdog_tick(monkeypatch, qwen):
    monkeypatch.setitem(main.ENGINES, "qwen", qwen)
    monkeypatch.setattr(main, "_reclaim_host_and_vram", lambda: None)
    monkeypatch.setenv("QWEN_BASE17_IDLE_TTL", "5")
    calls = {"n": 0}

    async def fake_sleep(_):
        calls["n"] += 1
        if calls["n"] > 1:
            raise asyncio.CancelledError

    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main._qwen_design_idle_watchdog())


def test_idle_watchdog_frees_base17_without_a_lease(monkeypatch):
    main._render_leases.clear()
    qwen = _fake_qwen(True)
    qwen.maybe_free_idle_design = lambda ttl: False
    _run_one_watchdog_tick(monkeypatch, qwen)
    assert qwen._base17 is None


def test_idle_watchdog_keeps_base17_while_a_render_lease_is_live(monkeypatch):
    main._render_leases.clear()
    main._render_lease_set("castwright-server", 60)
    try:
        qwen = _fake_qwen(True)
        qwen.maybe_free_idle_design = lambda ttl: False
        _run_one_watchdog_tick(monkeypatch, qwen)
        assert qwen._base17 is not None
    finally:
        main._render_leases.clear()


def test_a_lease_expires_on_its_own_and_is_capped(monkeypatch):
    main._render_leases.clear()
    t = {"now": 1000.0}
    monkeypatch.setattr(main.time, "monotonic", lambda: t["now"])
    main._render_lease_set("srv", 10)
    assert main._render_lease_active()
    t["now"] += 11
    assert not main._render_lease_active(), "a crashed server must not pin VRAM"
    main._render_lease_set("srv", 10_000)
    t["now"] += main._RENDER_LEASE_MAX_S + 1
    assert not main._render_lease_active(), "ttl is capped"
    main._render_lease_set("srv", 30)
    main._render_lease_set("srv", 0)
    assert not main._render_lease_active(), "ttl<=0 releases"


def test_render_lease_route(monkeypatch):
    from fastapi.testclient import TestClient

    main._render_leases.clear()
    c = TestClient(main.app)
    r = c.post("/render-lease", json={"holder": "srv", "ttl_seconds": 60})
    assert r.status_code == 200 and r.json()["active"] is True
    assert c.post("/render-lease", json={"holder": "srv", "ttl_seconds": 0}).json()["active"] is False
    assert c.post("/render-lease", json={"ttl_seconds": 5}).status_code == 400
    assert c.post("/render-lease", json={"holder": "x", "ttl_seconds": True}).status_code == 400
    main._render_leases.clear()


# --- pass 2: refusal body, ladder target, NaN lease, survivors -------------


def _state_probe(state, total=TOTAL, index=0):
    return lambda: [{"kind": "cuda", "index": index, "label": "g", "totalMb": total, "freeMb": state["free"]}]


def test_credited_refusal_reports_what_must_be_free_beside_the_weights(monkeypatch):
    """S1: base17 resident next to an idle analyzer. Node compares neededMb with
    the card's RAW free memory (capacity-retry analyzerEvictWouldHelp), so the
    refusal must say 6144 - W, or the analyzer is never evicted."""
    analyzer = 3000
    state = {"free": TOTAL - OTHER_MB - 3950 - analyzer}  # 942
    qwen = _fake_qwen(True, weights_mb=3700)
    pc = _wire(monkeypatch, qwen, _state_probe(state), steps=lambda dk, eng: [])

    async def once():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
            return adm

    assert asyncio.run(once()) == {"noCapacity": {"neededMb": 6144 - 3700, "deviceKey": "cuda:0"}}
    assert state["free"] + analyzer >= 6144 - 3700, "Node's analyzerEvictWouldHelp would now say yes"
    state["free"] += analyzer  # ...and once the analyzer is evicted the sidecar admits
    assert asyncio.run(once()) == {"device": "cuda:0"}


def test_admit_reports_the_same_credited_refusal(monkeypatch):
    state = {"free": 942}
    qwen = _fake_qwen(True, weights_mb=3700)
    pc = _wire(monkeypatch, qwen, _state_probe(state), steps=lambda dk, eng: [])
    out = asyncio.run(pc.admit("qwen", "1.7b", {}, cpu_capable=False, heavy=True))
    assert out == {"noCapacity": {"neededMb": 6144 - 3700, "deviceKey": "cuda:0"}}


def test_two_gpus_refusal_ladder_and_reclaim_stay_on_the_credited_card(monkeypatch):
    """S2: base17 on the tight cuda:0, a roomy eGPU on cuda:1. The refusal names
    cuda:0 (not the eGPU), the ladder and the stranded-cache reclaim run against
    cuda:0, and nothing is run for cuda:1."""
    devs = [
        {"kind": "cuda", "index": 0, "label": "laptop", "totalMb": 8192, "freeMb": 900},
        {"kind": "cuda", "index": 1, "label": "egpu", "totalMb": 12288, "freeMb": 9000},
    ]
    seen = []

    def steps(dk, eng):
        seen.append(dk)
        return []

    qwen = _fake_qwen(True, weights_mb=3700)
    pc = _wire(monkeypatch, qwen, lambda: devs, steps=steps)

    async def once():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
            return adm

    assert asyncio.run(once()) == {"noCapacity": {"neededMb": 6144 - 3700, "deviceKey": "cuda:0"}}
    assert set(seen) == {"cuda:0"}
    assert pc._test_reclaims == ["cuda:0"]
    pc._test_reclaims.clear()
    pc._last_reclaim.clear()  # the 30 s per-device reclaim cooldown
    seen.clear()
    out = asyncio.run(pc.admit("qwen", "1.7b", {}, cpu_capable=False, heavy=True))
    assert out == {"noCapacity": {"neededMb": 6144 - 3700, "deviceKey": "cuda:0"}}
    assert set(seen) == {"cuda:0"}
    assert pc._test_reclaims == ["cuda:0"]


def test_a_request_that_fits_with_the_credit_runs_no_evict_step(monkeypatch):
    """Kills 'credit dropped from the initial try_hold': it fits at once, so a warm
    design / ASR / SPK / Coqui model must not be evicted for it."""
    qwen = _fake_qwen()
    ran = []

    def steps(dk, eng):
        return [main.EvictStep("other", None, lambda: ran.append("other") or True)]

    pc = _wire(monkeypatch, qwen, _one_card(qwen), steps=steps)

    async def once():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
            return adm

    assert asyncio.run(once()) == {"device": "cuda:0"}
    assert ran == []


def test_the_ladder_stops_at_the_first_step_that_fits_with_the_credit(monkeypatch):
    """Kills 'credit dropped from the ladder's _fits': after step 1 frees 2000 MB
    the request fits ONLY with the credit; a second step must not run."""
    qwen = _fake_qwen(True, weights_mb=3900)
    state = {"free": 1000}
    ran = []

    def s1():
        ran.append("s1")
        state["free"] += 2000
        return True

    def s2():
        ran.append("s2")
        return True

    pc = _wire(
        monkeypatch, qwen, _state_probe(state),
        steps=lambda dk, eng: [main.EvictStep("s1", None, s1), main.EvictStep("s2", None, s2)],
    )

    async def once():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
            return adm

    assert asyncio.run(once()) == {"device": "cuda:0"}
    assert ran == ["s1"]
    assert pc._test_reclaims == [], "admitted by the ladder, not by the last-resort reclaim"


def test_protection_is_counted_not_boolean_across_overlapping_reservations(monkeypatch):
    """Two credited 1.7b reservations can overlap on a big card; releasing the
    first must leave the second protected."""
    qwen = _fake_qwen(True, weights_mb=3900)
    state = {"free": 12000}
    pc = _wire(monkeypatch, qwen, _state_probe(state, total=16384), steps=lambda dk, eng: [])

    async def body():
        a = pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True)
        b = pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True)
        assert await a.__aenter__() == {"device": "cuda:0"}
        assert await b.__aenter__() == {"device": "cuda:0"}
        assert pc._protected_steps["qwen.base17"] == 2
        await a.__aexit__(None, None, None)
        assert pc._protected_steps["qwen.base17"] == 1, "B is still admitted and must stay protected"
        await b.__aexit__(None, None, None)
        assert pc._protected_steps["qwen.base17"] == 0

    asyncio.run(body())


def test_protection_registration_cannot_raise_between_hold_and_try(monkeypatch):
    """The hook is read once, inside the admission lock: a hook that raises on a
    second call must not leak the ledger hold."""
    qwen = _fake_qwen()
    pc = _wire(monkeypatch, qwen, _one_card(qwen))
    real = pc.own_resident_tier
    calls = {"n": 0}

    def once_only(engine, model, cfg):
        calls["n"] += 1
        if calls["n"] > 1:
            raise RuntimeError("second read")
        return real(engine, model, cfg)

    monkeypatch.setattr(pc, "own_resident_tier", once_only)

    async def body():
        async with pc.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True) as adm:
            return adm

    assert asyncio.run(body()) == {"device": "cuda:0"}
    assert pc.ledger.reserved_mb("cuda:0") == 0
    assert calls["n"] == 1


def test_lease_rejects_non_finite_ttl(monkeypatch):
    """json.loads accepts NaN/Infinity; NaN never expires (`nan <= now` is False)."""
    from fastapi.testclient import TestClient

    main._render_leases.clear()
    c = TestClient(main.app)
    for raw in ("NaN", "Infinity", "-Infinity"):
        r = c.post("/render-lease", content=f'{{"holder":"x","ttl_seconds":{raw}}}', headers={"content-type": "application/json"})
        assert r.status_code == 400, raw
    assert not main._render_lease_active()
    main._render_leases.clear()
