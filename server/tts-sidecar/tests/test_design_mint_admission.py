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
