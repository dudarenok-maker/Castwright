"""ASR + ECAPA unload/infer race (#1894, found during its review).

Both engines hold `_infer_lock` across their forward but their `unload()`
never acquires it, and `maybe_free_idle` calls `unload()` directly. Since both
are already driven by `_idle_evict(0.0)`, an admission-path evict can null the
model mid-forward. Same defect the Coqui work fixed, one layer over.
"""
import importlib, os, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


def test_asr_unload_waits_for_an_in_flight_transcribe(monkeypatch):
    entered, release = threading.Event(), threading.Event()

    class _FakeModel:
        def transcribe(self, audio, **kw):
            entered.set()
            release.wait(timeout=5)
            return ([], type("I", (), {"language": "en"})())

    eng = main.WhisperEngine()
    monkeypatch.setattr(eng, "_ensure_loaded", lambda device=None: None)
    monkeypatch.setattr(eng, "_pcm_to_float32_16k", lambda pcm, sr: [0.0])
    eng._model = _FakeModel()
    eng._last_used = time.monotonic()

    errors: list[BaseException] = []

    def run():
        try:
            eng.transcribe(b"\x00\x00", 16000)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    t = threading.Thread(target=run)
    t.start()
    assert entered.wait(timeout=5), "transcribe never entered the forward"

    freed = threading.Event()

    def run_unload():
        eng.unload()
        freed.set()

    u = threading.Thread(target=run_unload)
    u.start()
    assert not freed.wait(timeout=0.3), "unload() did not wait for the forward"

    release.set()
    t.join(timeout=5)
    u.join(timeout=5)
    assert errors == [], f"transcribe raised while unload raced it: {errors!r}"
    assert eng._model is None


def test_asr_maybe_free_idle_skips_an_in_flight_transcribe(monkeypatch):
    """The fast-out must exist, or admission blocks on the whole forward."""
    eng = main.WhisperEngine()
    eng._model = object()
    eng._last_used = time.monotonic() - 600.0  # long idle
    eng._infer_in_flight = 1
    assert eng.maybe_free_idle(120.0) is False
    assert eng._model is not None


def test_spk_unload_waits_for_an_in_flight_embed(monkeypatch):
    entered, release = threading.Event(), threading.Event()

    class _FakeEncoder:
        def encode_batch(self, t):
            entered.set()
            release.wait(timeout=5)
            import numpy as np
            return _FakeOut(np.ones((1, 4), dtype="float32"))

    class _FakeOut:
        def __init__(self, arr):
            self._arr = arr

        def squeeze(self):
            return self

        def cpu(self):
            return self

        def numpy(self):
            return self._arr.squeeze()

        def astype(self, dt):
            return self._arr.squeeze().astype(dt)

    eng = main.SpeakerEngine()
    eng._model = _FakeEncoder()
    eng._last_used = time.monotonic()

    errors: list[BaseException] = []

    def run():
        try:
            eng.embed(b"\x00\x00" * 160, 16000)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    t = threading.Thread(target=run)
    t.start()
    assert entered.wait(timeout=5), "embed never entered the forward"

    freed = threading.Event()

    def run_unload():
        eng.unload()
        freed.set()

    u = threading.Thread(target=run_unload)
    u.start()
    assert not freed.wait(timeout=0.3), "unload() did not wait for the forward"

    release.set()
    t.join(timeout=5)
    u.join(timeout=5)
    assert errors == [], f"embed raised while unload raced it: {errors!r}"
    assert eng._model is None


def test_spk_maybe_free_idle_skips_an_in_flight_embed(monkeypatch):
    eng = main.SpeakerEngine()
    monkeypatch.setattr(main, "_parse_device", lambda d: ("cuda", 0))
    eng._model = object()
    eng._last_used = time.monotonic() - 600.0
    eng._infer_in_flight = 1
    assert eng.maybe_free_idle(120.0) is False
    assert eng._model is not None
