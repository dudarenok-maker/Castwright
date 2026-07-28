"""CoquiEngine synth-lock + idle-evict (#1894).

The lock exists because /unload (the UI Stop button) and /synthesize both run
on the worker pool via asyncio.to_thread, so `unload()` could null `_tts` while
`synthesize()` was mid-forward -> AttributeError, a killed chapter.
"""
import importlib, os, sys, threading, time

import pytest  # for the xfail marker on the evict-gap test (removed in Task 2)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


class _FakeTts:
    """Stands in for the loaded XTTS model. `tts()` signals that it has entered
    the forward, then blocks until released — so a test can hold a forward open
    and race unload() against it deterministically, with no sleeps."""

    def __init__(self, entered=None, release=None):
        self.entered = entered
        self.release = release
        self.synthesizer = type("S", (), {"output_sample_rate": 24000})()

    def tts(self, text, speaker, language):
        if self.entered is not None:
            self.entered.set()
        if self.release is not None:
            self.release.wait(timeout=5)
        return [0.0, 0.1, -0.1]


def _loaded_coqui(monkeypatch, fake_tts):
    """A CoquiEngine with a fake model already 'loaded'. `_ensure_loaded` is
    neutered so no real XTTS is pulled. `_last_used` is stamped because a real
    load stamps it too (see Task 2) — leaving it 0.0 would make the engine look
    infinitely idle and mask TTL bugs."""
    eng = main.CoquiEngine()
    monkeypatch.setattr(eng, "_ensure_loaded", lambda model: None)
    eng._tts = fake_tts
    eng._speakers = ["Claribel Dervla"]
    eng._resolved_device = "cuda:0"
    eng._device = "cuda:0"
    eng._last_used = time.monotonic()
    return eng


def test_unload_waits_for_an_in_flight_synth(monkeypatch):
    """The regression test for the crash: unload() must not null `_tts` while a
    forward is running. Without the lock, `synthesize` raises AttributeError."""
    entered, release = threading.Event(), threading.Event()
    eng = _loaded_coqui(monkeypatch, _FakeTts(entered=entered, release=release))

    errors: list[BaseException] = []
    done = threading.Event()

    def run_synth():
        try:
            eng.synthesize("xtts", "Claribel Dervla", "hello")
        except BaseException as e:  # noqa: BLE001 - we assert on it
            errors.append(e)
        finally:
            done.set()

    t = threading.Thread(target=run_synth)
    t.start()
    # Wait for the forward to actually START rather than sleeping — a sleep
    # flakes on a loaded box, and if the synth hasn't entered yet then unload()
    # completes immediately and the assertion below fails for the wrong reason.
    assert entered.wait(timeout=5), "synth never entered the forward"

    unloaded = threading.Event()

    def run_unload():
        eng.unload()
        unloaded.set()

    u = threading.Thread(target=run_unload)
    u.start()
    # unload must be BLOCKED on the lock while the forward is open.
    assert not unloaded.wait(timeout=0.3), "unload() did not wait for the synth"

    release.set()
    t.join(timeout=5)
    u.join(timeout=5)

    assert errors == [], f"synth raised while unload raced it: {errors!r}"
    assert eng._tts is None  # the unload still happened, just afterwards


def test_synthesize_tracks_in_flight_and_last_used(monkeypatch):
    """`maybe_free_idle` (Task 2) fast-outs on these two fields, so the synth
    path has to maintain them."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    assert eng._synth_in_flight == 0

    before = time.monotonic()
    eng.synthesize("xtts", "Claribel Dervla", "hello")

    assert eng._synth_in_flight == 0  # decremented on the way out
    assert eng._last_used >= before


@pytest.mark.xfail(raises=AttributeError, strict=False)
def test_synthesize_survives_an_evict_that_wins_the_ensure_gap(monkeypatch):
    """The OTHER interleaving, and the one the counter alone does not cover.

    `_ensure_loaded` runs outside the lock (a cold XTTS pull is ~90s and must
    not block the Stop button). If an admission-path evict frees the model in
    the gap between that ensure and the lock acquire, the forward must RELOAD
    rather than assert. This is why `synthesize` re-ensures under the lock —
    exactly what QwenEngine does at main.py:4439-4442."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._last_used = 0.0  # look infinitely idle so the evict will fire

    def ensure_then_evict(model):
        # Simulate the racing evict landing right after the caller's ensure.
        if eng._tts is None:
            eng._tts = _FakeTts()  # the "reload" a real _ensure_loaded performs
            eng._speakers = ["Claribel Dervla"]
            return
        eng.maybe_free_idle(30.0)

    monkeypatch.setattr(eng, "_ensure_loaded", ensure_then_evict)

    # Must not raise. The first ensure triggers the evict; the re-ensure under
    # the lock finds `_tts is None` and reloads.
    eng.synthesize("xtts", "Claribel Dervla", "hello")
    assert eng._tts is not None
