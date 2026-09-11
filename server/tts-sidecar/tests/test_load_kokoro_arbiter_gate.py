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
    # B3 fix: Neutralize PRELOAD_KOKORO so the startup hook doesn't eagerly
    # warm a fake Kokoro before the test's own /load call, which would cause
    # /load to hit the fast-path short-circuit and skip the arbiter gate.
    monkeypatch.setenv("PRELOAD_KOKORO", "0")
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "0")
    fake = _FakeLoadKokoro()
    monkeypatch.setitem(main.ENGINES, "kokoro", fake)
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        # B2 fix: Pin shares_device AFTER entering the lifespan (which runs
        # _configure_vd_kokoro_coupling and would otherwise reset it based on
        # the box's QWEN_DEVICE/KOKORO_DEVICE env). Save and restore the prior
        # value to avoid bleeding into other tests in the session.
        prior = main._VD_KOKORO._shares_device
        main._VD_KOKORO._shares_device = True
        c.fake_kokoro = fake  # type: ignore[attr-defined]
        try:
            yield c
        finally:
            main._VD_KOKORO._shares_device = prior
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


def test_startup_preload_kokoro_uses_guarded_path(monkeypatch):
    """B1 fix: Verify that startup preload of Kokoro (when PRELOAD_KOKORO=1)
    routes through _kokoro_ensure_loaded_guarded and is pinned to that call
    site. This test fails if someone removes ONLY the guard from the startup
    preload path (line 10260) while leaving the /load path's guard intact,
    catching a partial revert of the fix."""
    # Capture calls to verify the guard path was used
    ensure_loaded_guarded_calls: list[tuple[str, Optional[str]]] = []

    def fake_guarded(kokoro, model, device=None):
        ensure_loaded_guarded_calls.append((model, device))

    monkeypatch.setenv("PRELOAD_KOKORO", "1")
    fake = _FakeLoadKokoro()
    monkeypatch.setitem(main.ENGINES, "kokoro", fake)
    monkeypatch.setattr(main, "_kokoro_ensure_loaded_guarded", fake_guarded)

    main._reset_poison_for_test()
    with TestClient(main.app):
        pass  # lifespan startup/shutdown
    main._reset_poison_for_test()

    # Verify that _kokoro_ensure_loaded_guarded was called exactly once
    # during startup with ("v1", None) — the startup preload path args.
    assert ensure_loaded_guarded_calls == [("v1", None)], (
        f"startup preload didn't use _kokoro_ensure_loaded_guarded correctly; "
        f"calls = {ensure_loaded_guarded_calls}"
    )


@pytest.fixture
def load_client_with_admission(monkeypatch):
    """Fixture for testing the admission-ON code path (SEG_CAPACITY_ADMISSION=1).

    This exercises the PRODUCTION-DEFAULT path that goes through line ~11306
    in main.py, as opposed to the admission-OFF path (line ~11309) tested by
    the main `load_client` fixture."""
    monkeypatch.setenv("PRELOAD_KOKORO", "0")
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    fake = _FakeLoadKokoro()
    monkeypatch.setitem(main.ENGINES, "kokoro", fake)
    # Mock the _placement.probe to return a device list so admission doesn't
    # block on real hardware detection
    monkeypatch.setattr(
        main._placement,
        "probe",
        lambda: [
            {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
        ],
    )
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        prior = main._VD_KOKORO._shares_device
        main._VD_KOKORO._shares_device = True
        c.fake_kokoro = fake  # type: ignore[attr-defined]
        try:
            yield c
        finally:
            main._VD_KOKORO._shares_device = prior
    main._reset_poison_for_test()


def test_load_kokoro_admission_on_blocks_while_design_active(load_client_with_admission):
    """B8 fix: Verify that /load {"engine":"kokoro"} blocks during an active
    VoiceDesign when capacity admission is ENABLED (SEG_CAPACITY_ADMISSION=1).

    This is the PRODUCTION-DEFAULT code path (~main.py:11306), which the
    original admission-OFF test (SEG_CAPACITY_ADMISSION=0, ~main.py:11309) does
    NOT exercise. Pre-fix, this production-default path would bypass the
    arbiter gate entirely. The test mutation-verifies this: if you revert
    line 11306's `_kokoro_ensure_loaded_guarded` call back to a raw
    `kokoro._ensure_loaded(...)`, this test must fail (the load will complete
    immediately instead of blocking)."""
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
        response_holder["response"] = load_client_with_admission.post(
            "/load", json={"engine": "kokoro"}
        )

    load_thread = threading.Thread(target=do_load)
    load_thread.start()

    # Give the /load call every chance to run to completion; it must NOT,
    # because the design above is still holding the arbiter. This verifies
    # the admission-ON path goes through the same arbiter gate as the
    # admission-OFF path.
    load_thread.join(timeout=0.5)
    assert load_thread.is_alive(), (
        "/load completed while a VoiceDesign was still active (admission ON) — "
        "the arbiter gate was bypassed in the admission-enabled code path (#3086/#3101)"
    )
    assert load_client_with_admission.fake_kokoro.load_calls == []

    release_design.set()
    design_thread.join(timeout=5)
    load_thread.join(timeout=5)
    assert not load_thread.is_alive(), "/load never completed after the design released"

    response = response_holder["response"]
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}
    # Device should be "cuda:0" because admission steers to the probed device
    # (The fake records only the device, not the model.)
    assert load_client_with_admission.fake_kokoro.load_calls == ["cuda:0"]
