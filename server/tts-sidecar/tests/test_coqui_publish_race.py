"""CoquiEngine._ensure_loaded publish race (#1918).

`_ensure_loaded` writes seven fields with no lock; `unload()` takes
`_synth_lock` and resets exactly those fields, including restoring
`_device = _requested_device` (#1730 gap 3). A Stop pressed during a cold load
interleaves: the unload's resets are overwritten by the still-running loader,
leaving a live `_tts` pinned to the last admitted card.
"""
from __future__ import annotations

import sys
import threading
import types
from pathlib import Path
from typing import Any

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# ── fake TTS/torch stubs ──────────────────────────────────────────────
# Mirrors tests/test_runtime_wiring.py's `load_stubs` fixture: install a fake
# `TTS.api.TTS` + `torch` in sys.modules so `_ensure_loaded`'s lazy imports
# resolve to controllable stubs and no real ~3 GB model loads.

class _FakeSpeakerManager:
    def __init__(self) -> None:
        self.name_to_id = {"Claribel Dervla": 0}


class _FakeSynthesizer:
    def __init__(self) -> None:
        self.tts_model = types.SimpleNamespace(speaker_manager=_FakeSpeakerManager())
        self.output_sample_rate = 24000


class _FakeCuda:
    """`is_available` True + `device_count` >= 1 so `_validate_cuda_index`
    (called with an explicit `cuda:0` override in every test here) passes."""

    @staticmethod
    def is_available() -> bool:
        return True

    @staticmethod
    def device_count() -> int:
        return 2

    @staticmethod
    def empty_cache() -> None:
        pass


def _install_fake_tts_torch(monkeypatch, tts_cls: Any) -> None:
    fake_tts_api = types.ModuleType("TTS.api")
    fake_tts_api.TTS = tts_cls
    fake_tts = types.ModuleType("TTS")
    fake_tts.api = fake_tts_api

    fake_torch = types.ModuleType("torch")
    fake_torch.cuda = _FakeCuda
    fake_torch.float16 = "FAKE_FLOAT16"

    monkeypatch.setitem(sys.modules, "TTS", fake_tts)
    monkeypatch.setitem(sys.modules, "TTS.api", fake_tts_api)
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


def _disable_deepspeed_and_half(monkeypatch) -> None:
    """Keep the fake TTS instance minimal — no `gpt.init_gpt_for_inference`
    hookup needed once deepspeed is off; fp16 flag doesn't matter for the
    load itself."""
    monkeypatch.setenv("COQUI_DEEPSPEED", "0")
    monkeypatch.setenv("COQUI_HALF", "0")


def test_an_unload_during_a_cold_load_wins(monkeypatch):
    """Park the loader mid-load, unload from another thread, release the loader.

    Fails against the wrong implementation: without the epoch check the loader
    publishes on top of the unload's resets, so `_tts` ends non-None with
    `_device == "cuda:0"` (the admitted card) instead of the requested pref.
    Both halves are asserted — the torn state IS `_tts` live + `_device`
    pinned, so asserting only one of them would pass against a partial fix.
    """
    _disable_deepspeed_and_half(monkeypatch)

    eng = main.CoquiEngine()
    eng._device = "auto"
    eng._requested_device = "auto"

    in_load = threading.Event()
    release = threading.Event()

    class _FakeTts:
        def __init__(self, *a: Any, **k: Any) -> None:
            in_load.set()
            release.wait(5)
            self.synthesizer = _FakeSynthesizer()

        def to(self, device: str) -> "_FakeTts":
            return self

    _install_fake_tts_torch(monkeypatch, _FakeTts)

    loader = threading.Thread(
        target=lambda: eng._ensure_loaded("xtts_v2", device="cuda:0")
    )
    loader.start()
    assert in_load.wait(5), "loader never entered TTS construction"
    eng.unload()  # Stop pressed mid-load
    release.set()
    loader.join(5)
    assert not loader.is_alive(), "loader thread did not finish within 5s"

    assert eng._tts is None
    assert eng._device == "auto"
    assert eng._resolved_device == "cpu"
    assert eng._speakers == []


def test_a_normal_load_still_publishes_every_field(monkeypatch):
    """Guard against the epoch check being too eager — an uncontended load must
    publish all seven fields. Fails against a fix that always discards."""
    _disable_deepspeed_and_half(monkeypatch)

    eng = main.CoquiEngine()
    eng._device = "auto"
    eng._requested_device = "auto"

    class _FakeTts:
        def __init__(self, *a: Any, **k: Any) -> None:
            self.synthesizer = _FakeSynthesizer()

        def to(self, device: str) -> "_FakeTts":
            return self

    _install_fake_tts_torch(monkeypatch, _FakeTts)

    eng._ensure_loaded("xtts_v2", device="cuda:0")

    assert eng._tts is not None
    assert eng._device == "cuda:0"
    assert eng._resolved_device == "cuda:0"
    assert eng._speakers == ["Claribel Dervla"]
    assert eng._last_used > 0.0


def test_the_reensure_under_the_lock_does_not_deadlock(monkeypatch):
    """`synthesize` calls `_ensure_loaded` while HOLDING `_synth_lock`; a publish
    that unconditionally acquires that non-reentrant lock self-deadlocks.

    Drives `_ensure_loaded(..., lock_held=True)` DIRECTLY on a cold engine
    while holding `_synth_lock` — going through `synthesize` instead would
    prove nothing: its pre-lock ensure already loads and publishes, so the
    in-lock re-ensure hits the `_tts is not None` fast-out and never reaches
    the publish at all.

    Fails against the wrong implementation by hanging. Bounded join only,
    never an unbounded one.
    """
    _disable_deepspeed_and_half(monkeypatch)

    eng = main.CoquiEngine()

    class _FakeTts:
        def __init__(self, *a: Any, **k: Any) -> None:
            self.synthesizer = _FakeSynthesizer()

        def to(self, device: str) -> "_FakeTts":
            return self

    _install_fake_tts_torch(monkeypatch, _FakeTts)

    done = threading.Event()

    def run() -> None:
        with eng._synth_lock:
            eng._ensure_loaded("xtts_v2", device="cuda:0", lock_held=True)
        done.set()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    assert done.wait(10), "publish self-deadlocked on the non-reentrant _synth_lock"
    assert eng._tts is not None
