"""Tests for capacity-admission + device-steer wrapping of `/load` (task 2,
vram-aware-placement plan). Mirrors test_devices.py's `/synthesize` admission
tests — same fixture shape, same `SEG_CAPACITY_ADMISSION` flag envelope —
but pins the `/load` contract instead: flag-OFF never probes, flag-ON steers
the winning device into the engine's `_ensure_loaded`/`_ensure_base_loaded`
call, and a no-fit probe returns 503 `{noCapacity, neededMb, deviceKey}`
before the engine is ever asked to load."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

# Add the sidecar root to sys.path so `import main` works regardless of
# pytest's collection directory — same pattern as test_devices.py.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


class _FakeLoadCoqui(main.CoquiEngine):
    """Coqui stand-in whose `_ensure_loaded` just records the `device` kwarg
    it was called with, instead of loading the real multi-gigabyte XTTS
    model — same spirit as test_smoke.py's `_FakeEngine`."""

    name = "coqui"

    def __init__(self) -> None:
        super().__init__()
        self.load_calls: list[tuple[str, Optional[str]]] = []

    def _ensure_loaded(self, model: str, device: Optional[str] = None) -> None:
        self.load_calls.append((model, device))
        self._tts = object()


@pytest.fixture
def load_client(monkeypatch):
    monkeypatch.delenv("COQUI_DEVICE", raising=False)
    fake = _FakeLoadCoqui()
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    # Drop the real Kokoro engine so TestClient's startup event doesn't try
    # to eager-preload it (mirrors test_smoke.py's `client` fixture).
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        c.fake_coqui = fake  # type: ignore[attr-defined]
        yield c
    main._reset_poison_for_test()


def test_load_flag_off_never_probes(monkeypatch, load_client):
    """Explicit opt-out (SEG_CAPACITY_ADMISSION=0): /load never calls the
    placement probe at all — this is the rollback path, the pre-admission
    behaviour byte-for-byte."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "0")
    probe_calls: list[int] = []
    monkeypatch.setattr(main._placement, "probe", lambda: probe_calls.append(1) or [])

    r = load_client.post("/load", json={"engine": "coqui"})

    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    assert probe_calls == []
    fake = load_client.fake_coqui
    assert fake.load_calls == [("xtts_v2", None)]


def test_load_flag_on_favours_roomier_device(monkeypatch, load_client):
    """Flag ON + a probe where both GPUs fit but cuda:1 is roomier -> the
    reservation admits onto cuda:1 and that concrete device is threaded into
    the engine's `_ensure_loaded` call."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [
            {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
            {"kind": "cuda", "index": 1, "label": "g1", "totalMb": 24000, "freeMb": 20000},
        ],
    )

    r = load_client.post("/load", json={"engine": "coqui"})

    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    fake = load_client.fake_coqui
    assert fake.load_calls == [("xtts_v2", "cuda:1")]


def test_load_nocapacity_returns_503(monkeypatch, load_client):
    """Flag ON + a probe that can't fit the peak -> 503 noCapacity, the
    engine is never asked to load."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [{"kind": "cuda", "index": 0, "freeMb": 500, "totalMb": 8000}],
    )

    r = load_client.post("/load", json={"engine": "coqui"})

    assert r.status_code == 503
    body = r.json()
    assert body["noCapacity"] is True and body["deviceKey"] == "cuda:0"
    assert body["neededMb"] > 0
    fake = load_client.fake_coqui
    assert fake.load_calls == []


# --- kokoro branch (main.py's kokoro `/load` arm) ---
# Same fixture shape as the coqui trio above, swapped onto KokoroEngine's
# `_ensure_loaded` sentinel (`_kokoro`) so the load path actually runs
# instead of short-circuiting on "already loaded".


class _FakeLoadKokoro(main.KokoroEngine):
    name = "kokoro"

    def __init__(self) -> None:
        super().__init__()
        self.load_calls: list[tuple[str, Optional[str]]] = []

    def _ensure_loaded(self, model: str, device: Optional[str] = None) -> None:
        self.load_calls.append((model, device))
        self._kokoro = object()


@pytest.fixture
def load_client_kokoro(monkeypatch):
    monkeypatch.delenv("KOKORO_DEVICE", raising=False)
    fake = _FakeLoadKokoro()
    monkeypatch.setitem(main.ENGINES, "kokoro", fake)
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        c.fake_kokoro = fake  # type: ignore[attr-defined]
        yield c
    main._reset_poison_for_test()


def test_load_kokoro_flag_on_favours_roomier_device(monkeypatch, load_client_kokoro):
    """Flag ON + a probe where cuda:1 is roomier -> the admitted device is
    threaded into `KokoroEngine._ensure_loaded`'s `device=` kwarg."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [
            {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
            {"kind": "cuda", "index": 1, "label": "g1", "totalMb": 24000, "freeMb": 20000},
        ],
    )

    r = load_client_kokoro.post("/load", json={"engine": "kokoro"})

    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    fake = load_client_kokoro.fake_kokoro
    assert fake.load_calls == [("v1", "cuda:1")]


def test_load_kokoro_falls_back_to_cpu_when_no_gpu_room(monkeypatch, load_client_kokoro):
    """Flag ON + a probe that can't fit any GPU: unlike coqui/qwen (heavy,
    no CPU path -> 503 noCapacity), kokoro's capacity profile is
    `cpu_capable=True, heavy=False` (`_ENGINE_CAPACITY_PROFILE`), so
    `PlacementController.reservation` admits onto "cpu" instead of ever
    returning `noCapacity` -> 200, not 503, and `device="cpu"` is threaded
    into `_ensure_loaded`."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [{"kind": "cuda", "index": 0, "freeMb": 500, "totalMb": 8000}],
    )

    r = load_client_kokoro.post("/load", json={"engine": "kokoro"})

    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    fake = load_client_kokoro.fake_kokoro
    assert fake.load_calls == [("v1", "cpu")]


# --- qwen branches (0.6B-Base + 1.7B-Base `/load` arms) ---
# Both branches share one QwenEngine instance/fixture — real QwenEngine()
# construction is cheap (no model I/O), and the two sentinels (`_base`,
# `_base17`) are independent, so one fake safely covers both arms.


class _FakeLoadQwen(main.QwenEngine):
    name = "qwen"

    def __init__(self) -> None:
        super().__init__()
        self.base_load_calls: list[Optional[str]] = []
        self.base17_load_calls: list[Optional[str]] = []

    def _ensure_base_loaded(self, device: Optional[str] = None) -> None:
        self.base_load_calls.append(device)
        self._base = object()

    def _ensure_base17_loaded(self, device: Optional[str] = None) -> None:
        self.base17_load_calls.append(device)
        self._base17 = object()


@pytest.fixture
def load_client_qwen(monkeypatch):
    monkeypatch.delenv("QWEN_DEVICE", raising=False)
    fake = _FakeLoadQwen()
    monkeypatch.setitem(main.ENGINES, "qwen", fake)
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        c.fake_qwen = fake  # type: ignore[attr-defined]
        yield c
    main._reset_poison_for_test()


def test_load_qwen_base_flag_on_favours_roomier_device(monkeypatch, load_client_qwen):
    """0.6B-Base branch (no `model` field / anything != "1.7b"): flag ON +
    cuda:1 roomier -> `_ensure_base_loaded(device="cuda:1")`."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [
            {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
            {"kind": "cuda", "index": 1, "label": "g1", "totalMb": 24000, "freeMb": 20000},
        ],
    )

    r = load_client_qwen.post("/load", json={"engine": "qwen"})

    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    fake = load_client_qwen.fake_qwen
    assert fake.base_load_calls == ["cuda:1"]
    assert fake.base17_load_calls == []


def test_load_qwen_base17_flag_on_favours_roomier_device(monkeypatch, load_client_qwen):
    """1.7B-Base branch (`model: "1.7b"`): flag ON + cuda:1 roomier ->
    `_ensure_base17_loaded(device="cuda:1")`."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [
            {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
            {"kind": "cuda", "index": 1, "label": "g1", "totalMb": 24000, "freeMb": 20000},
        ],
    )

    r = load_client_qwen.post("/load", json={"engine": "qwen", "model": "1.7b"})

    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    fake = load_client_qwen.fake_qwen
    assert fake.base17_load_calls == ["cuda:1"]
    assert fake.base_load_calls == []
