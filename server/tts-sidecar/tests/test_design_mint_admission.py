"""Tests for capacity-admission + device-steer wrapping of
`/qwen/design-voice` and `/qwen/mint-variant` (task 3, vram-aware-placement
plan). Mirrors test_load_admission.py's fixture shape and the same
`SEG_CAPACITY_ADMISSION` flag envelope: flag-OFF never probes and calls the
engine method with no `device` arg (today's behaviour byte-for-byte);
flag-ON reserves the `qwen.1.7b` footprint (7168 MB — both design and mint
run on the 1.7B model), steers the admitted device into the engine call, and
a no-fit probe returns 503 `{noCapacity, neededMb, deviceKey}` before the
engine is ever asked to design/mint."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


class _FakeDesignMintQwen(main.QwenEngine):
    """QwenEngine stand-in whose `design_voice`/`mint_variant` just record
    the args they were called with (including any trailing `device`)
    instead of running the real multi-gigabyte 1.7B model — same spirit as
    test_load_admission.py's `_FakeLoadQwen`."""

    name = "qwen"

    def __init__(self) -> None:
        super().__init__()
        self.design_calls: list[tuple] = []
        self.mint_calls: list[tuple] = []

    def design_voice(self, *args, **kwargs):  # noqa: D401 — test double
        self.design_calls.append((args, kwargs))
        return main.SynthResult(pcm=b"\x00\x00", sample_rate=24000)

    def mint_variant(self, *args, **kwargs):  # noqa: D401 — test double
        self.mint_calls.append((args, kwargs))
        return main.SynthResult(pcm=b"\x00\x00", sample_rate=24000)


@pytest.fixture
def design_client(monkeypatch):
    monkeypatch.delenv("QWEN_DEVICE", raising=False)
    fake = _FakeDesignMintQwen()
    monkeypatch.setitem(main.ENGINES, "qwen", fake)
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    monkeypatch.setattr(main, "_process_poisoned", False, raising=False)
    monkeypatch.setattr(main, "_restart_pending", False, raising=False)
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        c.fake_qwen = fake  # type: ignore[attr-defined]
        yield c
    main._reset_poison_for_test()


def _design_body():
    return {"voiceId": "qwen-x", "instruct": "a warm, gentle teenage girl"}


def _mint_body():
    return {
        "baseVoiceId": "qwen-base",
        "variantVoiceId": "qwen-base__angry",
        "emotionInstruct": "Delivered angrily, with raised intensity and edge.",
    }


# --- /qwen/design-voice -----------------------------------------------------


def test_design_flag_off_never_probes_no_device_arg(monkeypatch, design_client):
    """Default (flag unset): design-voice never calls the placement probe —
    the engine method is called with the same positional args as before,
    with no trailing device."""
    monkeypatch.delenv("SEG_CAPACITY_ADMISSION", raising=False)
    probe_calls: list[int] = []
    monkeypatch.setattr(main._placement, "probe", lambda: probe_calls.append(1) or [])

    r = design_client.post("/qwen/design-voice", json=_design_body())

    assert r.status_code == 200
    assert probe_calls == []
    fake = design_client.fake_qwen
    assert len(fake.design_calls) == 1
    args, kwargs = fake.design_calls[0]
    assert kwargs == {}
    assert len(args) == 8  # voice_id..fallback_for, no device
    assert args[0] == "qwen-x"


def test_design_flag_on_favours_roomier_device(monkeypatch, design_client):
    """Flag ON + a probe where cuda:1 is roomier -> the reservation admits
    onto cuda:1 and that concrete device is threaded as design_voice's
    trailing positional arg."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [
            {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
            {"kind": "cuda", "index": 1, "label": "g1", "totalMb": 24000, "freeMb": 20000},
        ],
    )

    r = design_client.post("/qwen/design-voice", json=_design_body())

    assert r.status_code == 200
    fake = design_client.fake_qwen
    assert len(fake.design_calls) == 1
    args, kwargs = fake.design_calls[0]
    assert kwargs == {}
    assert len(args) == 9
    assert args[-1] == "cuda:1"


def test_design_nocapacity_returns_503_needed_7168(monkeypatch, design_client):
    """Flag ON + a probe that can't fit the 1.7B footprint -> 503 noCapacity
    with neededMb == 7168 (proves the qwen.1.7b footprint was reserved), and
    design_voice is never called."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [{"kind": "cuda", "index": 0, "freeMb": 500, "totalMb": 8000}],
    )

    r = design_client.post("/qwen/design-voice", json=_design_body())

    assert r.status_code == 503
    body = r.json()
    assert body["noCapacity"] is True
    assert body["neededMb"] == 7168
    assert body["deviceKey"] == "cuda:0"
    fake = design_client.fake_qwen
    assert fake.design_calls == []


# --- /qwen/mint-variant ------------------------------------------------------


def test_mint_flag_off_never_probes_no_device_arg(monkeypatch, design_client):
    monkeypatch.delenv("SEG_CAPACITY_ADMISSION", raising=False)
    probe_calls: list[int] = []
    monkeypatch.setattr(main._placement, "probe", lambda: probe_calls.append(1) or [])

    r = design_client.post("/qwen/mint-variant", json=_mint_body())

    assert r.status_code == 200
    assert probe_calls == []
    fake = design_client.fake_qwen
    assert len(fake.mint_calls) == 1
    args, kwargs = fake.mint_calls[0]
    assert kwargs == {}
    assert len(args) == 7  # base_voice_id..report_progress, no device
    assert args[0] == "qwen-base"


def test_mint_flag_on_favours_roomier_device(monkeypatch, design_client):
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [
            {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
            {"kind": "cuda", "index": 1, "label": "g1", "totalMb": 24000, "freeMb": 20000},
        ],
    )

    r = design_client.post("/qwen/mint-variant", json=_mint_body())

    assert r.status_code == 200
    fake = design_client.fake_qwen
    assert len(fake.mint_calls) == 1
    args, kwargs = fake.mint_calls[0]
    assert kwargs == {}
    assert len(args) == 8
    assert args[-1] == "cuda:1"


def test_mint_nocapacity_returns_503_needed_7168(monkeypatch, design_client):
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [{"kind": "cuda", "index": 0, "freeMb": 500, "totalMb": 8000}],
    )

    r = design_client.post("/qwen/mint-variant", json=_mint_body())

    assert r.status_code == 503
    body = r.json()
    assert body["noCapacity"] is True
    assert body["neededMb"] == 7168
    assert body["deviceKey"] == "cuda:0"
    fake = design_client.fake_qwen
    assert fake.mint_calls == []


# --- device-steer atomicity (the task-3 TOCTOU fix) -------------------------
#
# The route tests above stub design_voice/mint_variant wholesale, so they can't
# see the ENGINE-INTERNAL device-steer. These drive the real
# `_ensure_design_loaded`/`_ensure_base17_loaded` cold-load machinery with an
# observable `_load_qwen_model` to prove the admitted card is honoured — and,
# under concurrency, that the shared `_cold_load_lock` serialises the two cold
# loads so a design admitted to cuda:1 and a mint admitted to cuda:0 can't
# clobber the single engine-wide `self._device` mid-load.


class _FakeLoadRecorder(main.QwenEngine):
    """Real QwenEngine cold-load path, but `_load_qwen_model` is an observable
    stub: it records the device `self._device` carried at load time and tracks
    the peak number of loads running at once. The shared `_cold_load_lock`
    guarantees that peak is 1; the pre-fix per-model locks let two cold loads
    overlap (peak 2) and clobber the shared device field."""

    def __init__(self, overlap_delay: float = 0.03) -> None:
        super().__init__()
        self.loaded: list[tuple[str, str]] = []
        self._in_load = 0
        self.peak_in_load = 0
        self._counter_lock = threading.Lock()
        self._overlap_delay = overlap_delay

    def _load_qwen_model(self, model_id: str):  # noqa: D401 — test double
        with self._counter_lock:
            self._in_load += 1
            self.peak_in_load = max(self.peak_in_load, self._in_load)
        # Widen the window so a per-model-lock regression reliably interleaves;
        # the shared lock keeps the two loads strictly sequential (peak == 1).
        time.sleep(self._overlap_delay)
        # Read LATE, mirroring `_load_qwen_model`'s `inner.to(self._device)` — a
        # concurrent load that overwrote `self._device` in the gap would be seen
        # here.
        dev = self._device
        with self._counter_lock:
            self._in_load -= 1
        self.loaded.append((model_id, dev))
        return object()


@pytest.fixture
def _stub_codec(monkeypatch):
    """The base/base17 cold paths call these post-load hooks on the loaded
    model; the recorder returns a bare sentinel, so no-op them."""
    monkeypatch.setattr(main, "_install_codec_timing", lambda *a, **k: None)
    monkeypatch.setattr(main, "_maybe_compile_codec", lambda *a, **k: False)
    monkeypatch.delenv("QWEN_DEVICE", raising=False)


def test_concurrent_design_and_mint_each_load_own_admitted_device(monkeypatch, _stub_codec):
    """THE regression: a design admitted to cuda:1 and a 1.7B/mint admitted to
    cuda:0, started together, must EACH load on their own card. With the shared
    `_cold_load_lock` the two cold loads never overlap (peak_in_load == 1) and
    neither clobbers the other's `self._device`. (Pre-fix, with a dedicated
    per-model lock each, they interleave: peak 2 and the design lands on
    cuda:0.)"""
    eng = _FakeLoadRecorder(overlap_delay=0.03)
    ready = threading.Barrier(2)

    def run_design():
        ready.wait()
        eng._ensure_design_loaded(device="cuda:1")

    def run_mint():
        ready.wait()
        eng._ensure_base17_loaded(device="cuda:0")

    ta = threading.Thread(target=run_design)
    tb = threading.Thread(target=run_mint)
    ta.start()
    tb.start()
    ta.join(5)
    tb.join(5)
    assert not ta.is_alive() and not tb.is_alive(), "a cold load deadlocked"

    by_model = dict(eng.loaded)
    assert by_model[eng.VOICEDESIGN_MODEL] == "cuda:1"
    assert by_model[eng.BASE17_MODEL] == "cuda:0"
    assert eng.peak_in_load == 1  # the shared lock serialised the two cold loads


def test_ensure_design_and_base17_for_mint_steer_own_device(monkeypatch, _stub_codec):
    """Sequential: `_ensure_design_loaded(cuda:1)` resolves+loads on cuda:1, and
    `_ensure_base17_for_mint(cuda:0)` FORWARDS its device into
    `_ensure_base17_loaded`, resolving+loading on cuda:0."""
    monkeypatch.setattr(main, "_qwen_base17_weights_present", lambda: True)
    eng = _FakeLoadRecorder(overlap_delay=0.0)

    eng._ensure_design_loaded(device="cuda:1")
    assert eng._device == "cuda:1"
    assert (eng.VOICEDESIGN_MODEL, "cuda:1") in eng.loaded

    eng._ensure_base17_for_mint(device="cuda:0")
    assert eng._device == "cuda:0"
    assert (eng.BASE17_MODEL, "cuda:0") in eng.loaded


def test_design_path_threads_same_device_into_design_and_base(monkeypatch, _stub_codec):
    """design_voice steers BOTH its VoiceDesign and its 0.6B-Base cold loads to
    the one admitted card — mirror that: `_ensure_design_loaded(cuda:1)` then
    `_ensure_base_loaded(cuda:1)` both land on cuda:1."""
    eng = _FakeLoadRecorder(overlap_delay=0.0)
    eng._ensure_design_loaded(device="cuda:1")
    eng._ensure_base_loaded(device="cuda:1")
    assert (eng.VOICEDESIGN_MODEL, "cuda:1") in eng.loaded
    assert (eng.BASE_MODEL, "cuda:1") in eng.loaded


def test_device_none_leaves_device_pref_untouched(monkeypatch, _stub_codec):
    """Flag-off parity: a `device=None` cold load never mutates `_device_pref`
    (the admission override is the ONLY writer of that field)."""
    monkeypatch.setattr(main, "_qwen_base17_weights_present", lambda: True)

    eng = _FakeLoadRecorder(overlap_delay=0.0)
    pref_before = eng._device_pref
    eng._ensure_design_loaded()  # device=None
    assert eng._device_pref == pref_before

    eng2 = _FakeLoadRecorder(overlap_delay=0.0)
    pref_before2 = eng2._device_pref
    eng2._ensure_base17_for_mint()  # device=None
    assert eng2._device_pref == pref_before2
