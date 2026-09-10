"""Regression test for the VD/Kokoro arbiter race (#3086/#3101).

`POST /load {"engine":"kokoro"}` used to call `KokoroEngine._ensure_loaded`
directly, bypassing `_VD_KOKORO.kokoro_synth()` entirely -- unlike
`KokoroEngine.synthesize()`, which already wraps its whole forward (load +
create) in that gate (test_design_kokoro_exclusion.py's
`test_kokoro_synthesize_acquires_the_arbiter`). A cold Kokoro load isn't just
bookkeeping: on the DirectML profile it runs a real one-shot forward
(`_directml_selftest_or_fallback`'s `kokoro.create("ok", ...)`) to prove the
provider actually works -- exactly the "raw Kokoro synth" that must not
co-reside with an active VoiceDesign forward. `main._kokoro_ensure_loaded_guarded`
closes that bypass by routing every cold load through the same arbiter gate.
"""
from __future__ import annotations

import sys
import threading
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


class _FakeLoadKokoro(main.KokoroEngine):
    """Kokoro stand-in whose `_ensure_loaded` just records the call instead of
    loading the real ONNX model -- same spirit as test_load_admission.py's
    `_FakeLoadCoqui`."""

    def __init__(self) -> None:
        super().__init__()
        self.load_calls: list[Optional[str]] = []

    def _ensure_loaded(self, model: str, device: Optional[str] = None) -> None:
        self.load_calls.append(device)
        self._kokoro = object()


@pytest.fixture
def load_client(monkeypatch):
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "0")
    fake = _FakeLoadKokoro()
    monkeypatch.setitem(main.ENGINES, "kokoro", fake)
    # Pin the single-card-box default regardless of what the real startup
    # coupling hook resolves on this test box (mirrors
    # test_design_kokoro_exclusion.py's autouse fixture).
    main._VD_KOKORO._shares_device = True
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        c.fake_kokoro = fake  # type: ignore[attr-defined]
        yield c
    main._reset_poison_for_test()


def test_load_kokoro_blocks_while_design_active(load_client):
    """A `/load {"engine":"kokoro"}` call must block until an active
    VoiceDesign forward (holding `_VD_KOKORO.design()`) releases -- the same
    guarantee `/synthesize` already had. Pre-fix, this call bypassed the
    arbiter and completed immediately regardless of an active design."""
    design_holding = threading.Event()
    release_design = threading.Event()

    def hold_design():
        with main._VD_KOKORO.design():
            design_holding.set()
            release_design.wait(timeout=5)

    design_thread = threading.Thread(target=hold_design)
    design_thread.start()
    assert design_holding.wait(timeout=2), "design never entered the arbiter — test bug"

    response_holder: dict[str, object] = {}

    def do_load():
        response_holder["response"] = load_client.post("/load", json={"engine": "kokoro"})

    load_thread = threading.Thread(target=do_load)
    load_thread.start()

    # Give the /load call every chance to run to completion; it must NOT,
    # because the design above is still holding the arbiter.
    load_thread.join(timeout=0.5)
    assert load_thread.is_alive(), (
        "/load completed while a VoiceDesign forward was still active — "
        "the arbiter gate was bypassed (#3086/#3101)"
    )
    assert load_client.fake_kokoro.load_calls == []

    release_design.set()
    design_thread.join(timeout=5)
    load_thread.join(timeout=5)
    assert not load_thread.is_alive(), "/load never completed after the design released"

    response = response_holder["response"]
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}
    assert load_client.fake_kokoro.load_calls == [None]
