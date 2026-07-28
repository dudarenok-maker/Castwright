"""CoquiEngine._ensure_loaded publish race (#1918).

`_ensure_loaded` writes seven fields with no lock; `unload()` takes
`_synth_lock` and resets exactly those fields, including restoring
`_device = _requested_device` (#1730 gap 3). A Stop pressed during a cold load
interleaves: the unload's resets are overwritten by the still-running loader,
leaving a live `_tts` pinned to the last admitted card.
"""
from __future__ import annotations

import logging
import sys
import threading
import time
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


def test_an_unload_during_a_cold_load_wins(monkeypatch, caplog):
    """Park the loader mid-load, unload from another thread, release the loader.

    Fails against the wrong implementation: without the epoch check the loader
    publishes on top of the unload's resets, so `_tts` ends non-None with
    `_device == "cuda:0"` (the admitted card) instead of the requested pref.
    Both halves are asserted — the torn state IS `_tts` live + `_device`
    pinned, so asserting only one of them would pass against a partial fix.

    The loader's exceptions are captured into `errors`, not just checked via
    `not loader.is_alive()` (#1918 review F4) — a thread that raised and one
    that returned normally both make `is_alive()` False afterwards, so that
    alone can't tell "discarded cleanly" from "the loader body blew up before
    it even reached the discard branch", which would make every assertion
    below pass vacuously against state `__init__`/the test already set. The
    `caplog` check pins that the discard branch actually ran.
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

    errors: list[BaseException] = []

    def run_loader() -> None:
        try:
            eng._ensure_loaded("xtts_v2", device="cuda:0")
        except BaseException as e:  # noqa: BLE001 - asserted on below
            errors.append(e)

    loader = threading.Thread(target=run_loader)
    with caplog.at_level(logging.INFO, logger="sidecar"):
        loader.start()
        assert in_load.wait(5), "loader never entered TTS construction"
        eng.unload()  # Stop pressed mid-load
        release.set()
        loader.join(5)
    assert not loader.is_alive(), "loader thread did not finish within 5s"
    assert errors == [], f"loader raised instead of discarding cleanly: {errors!r}"

    assert eng._tts is None
    assert eng._device == "auto"
    assert eng._resolved_device == "cpu"
    assert eng._speakers == []
    assert any("Coqui load discarded" in r.getMessage() for r in caplog.records), (
        "the discard branch never logged — the loader took some other path"
    )


def test_a_normal_load_still_publishes_every_field(monkeypatch):
    """Guard against the epoch check being too eager — an uncontended load must
    publish all SEVEN fields. Fails against a fix that always discards.

    Deepspeed stays off (avoids needing a `gpt.init_gpt_for_inference` hookup
    on the fake), but — unlike the other tests in this file — `COQUI_HALF` is
    left at `1` rather than `0` (#1918 review F5): `_use_half` can only ever
    discriminate a broken implementation when the resolved value is `True`,
    since a fixture that forces it off makes `assert eng._use_half is True`
    fail identically whether or not `_publish_loaded_locked` actually wired
    `use_half` through.
    """
    monkeypatch.setenv("COQUI_DEEPSPEED", "0")
    monkeypatch.setenv("COQUI_HALF", "1")

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
    assert eng._torch is not None
    assert eng._device == "cuda:0"
    assert eng._resolved_device == "cuda:0"
    assert eng._speakers == ["Claribel Dervla"]
    assert eng._last_used > 0.0
    assert eng._use_half is True


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


def test_a_second_concurrent_loader_does_not_overwrite_the_first():
    """The `_tts is not None` half of `_publish_loaded_locked`'s guard (#1918
    review F2) — the OTHER loser the epoch check alone doesn't cover.

    A `/load` request and `synthesize`'s pre-lock ensure are serialised by
    different primitives (an asyncio `_load_lock` and nothing, respectively),
    so two callers can both pass `_ensure_loaded`'s `_tts is None` fast-out
    while `_tts` is still `None`, both load, and both arrive at the publish
    with the SAME unchanged epoch snapshot — nothing has torn anything down,
    so the epoch check alone can't tell them apart. Drives
    `_publish_loaded_locked` directly, twice, with that shared snapshot — a
    pure guard test, no TTS/torch stubbing needed. Fails against the wrong
    implementation (`or self._tts is not None` deleted from the guard): the
    second publish succeeds and `eng._tts is tts_b`, not `tts_a`.

    Continues on to cover F6 (`_drop_model_locked`'s own epoch bump, reached
    via `maybe_free_idle` rather than `unload()`): evicts A's model via
    `maybe_free_idle` (idle TTL, no Stop involved) and confirms a THIRD
    loader whose epoch snapshot predates the evict — i.e. equal to A's and
    B's — still gets discarded. Without that second bump, `maybe_free_idle`'s
    teardown leaves the epoch unchanged, so C's stale snapshot would match
    AND find `_tts is None` (just evicted) — passing the guard's `or` outright
    and publishing on top of the evict.
    """
    eng = main.CoquiEngine()
    epoch = eng._load_epoch  # both racing loaders snapshot the SAME epoch

    tts_a = object()
    tts_b = object()

    with eng._synth_lock:
        published_a = eng._publish_loaded_locked(
            epoch, tts_a, None, "cuda:0", False, ["A"]
        )
    assert published_a is True

    with eng._synth_lock:
        published_b = eng._publish_loaded_locked(
            epoch, tts_b, None, "cuda:0", False, ["B"]
        )
    assert published_b is False
    assert eng._tts is tts_a, "the second loader overwrote the first"
    assert eng._speakers == ["A"]

    # F6: evict A's model WITHOUT going through unload() — maybe_free_idle
    # reaches _drop_model_locked directly, so its own bump (not unload()'s
    # unconditional one) is what has to invalidate C's stale snapshot below.
    eng._last_used = time.monotonic() - 999.0  # looks idle
    assert eng.maybe_free_idle(0.0) is True
    assert eng._tts is None

    tts_c = object()
    with eng._synth_lock:
        published_c = eng._publish_loaded_locked(
            epoch, tts_c, None, "cuda:0", False, ["C"]
        )
    assert published_c is False, "a stale loader published on top of an idle evict"
    assert eng._tts is None
