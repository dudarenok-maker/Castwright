"""CoquiEngine synth-lock + idle-evict (#1894).

The lock exists because /unload (the UI Stop button) and /synthesize both run
on the worker pool via asyncio.to_thread, so `unload()` could null `_tts` while
`synthesize()` was mid-forward -> AttributeError, a killed chapter.
"""
import importlib, os, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


class _FakeTts:
    """Stands in for the loaded XTTS model. `tts()` signals that it has entered
    the forward, then blocks until released — so a test can hold a forward open
    and race unload() against it deterministically, with no sleeps. `on_enter`,
    if given, is called (with no args) once the forward has started — lets a
    test observe engine state exactly while the synth is mid-flight, which a
    post-call assertion can't distinguish from a no-op implementation."""

    def __init__(self, entered=None, release=None, on_enter=None):
        self.entered = entered
        self.release = release
        self.on_enter = on_enter
        self.synthesizer = type("S", (), {"output_sample_rate": 24000})()

    def tts(self, text, speaker, language):
        if self.entered is not None:
            self.entered.set()
        if self.on_enter is not None:
            self.on_enter()
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
    path has to maintain them. Both fields read back to their pre-call resting
    state (0 / a valid timestamp) whether or not `synthesize` ever actually
    maintained them — so this asserts the MID-FORWARD state, observed from
    inside the fake's `tts()`, which a no-op ("declare the field, never touch
    it") implementation cannot fake."""
    observed_in_flight: list[int] = []
    eng = _loaded_coqui(
        monkeypatch,
        _FakeTts(on_enter=lambda: observed_in_flight.append(eng._synth_in_flight)),
    )
    assert eng._synth_in_flight == 0

    # Sentinel instead of `before = time.monotonic()` + a strict `>` after: on
    # Windows/Python 3.12, time.monotonic() is backed by GetTickCount64
    # (~15.6ms granularity — QPC-backed monotonic only lands in 3.13), and a
    # synth against a fake completes in microseconds, so before/after routinely
    # read the IDENTICAL float and a strict `>` would flake. Zeroing first and
    # asserting `> 0.0` after is exact, timing-independent, and still fails
    # against an implementation that never re-stamps `_last_used`.
    eng._last_used = 0.0
    eng.synthesize("xtts", "Claribel Dervla", "hello")

    assert observed_in_flight == [1]  # incremented BEFORE the forward, not after
    assert eng._synth_in_flight == 0  # decremented on the way out
    assert eng._last_used > 0.0


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


def test_maybe_free_idle_noop_when_nothing_resident():
    eng = main.CoquiEngine()
    assert eng.maybe_free_idle(0.0) is False


def test_maybe_free_idle_does_not_free_a_freshly_loaded_model(monkeypatch):
    """A model loaded but never synthesised must NOT read as infinitely idle.
    `_last_used` starts at 0.0, so without a stamp at load time the engine is
    evictable the instant it finishes the ~90s load the user just paid for."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    assert eng.maybe_free_idle(30.0) is False
    assert eng._tts is not None


def test_maybe_free_idle_respects_the_ttl(monkeypatch):
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._last_used = time.monotonic()  # just used
    assert eng.maybe_free_idle(30.0) is False
    assert eng._tts is not None


def test_maybe_free_idle_frees_past_the_ttl(monkeypatch):
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._last_used = time.monotonic() - 120.0  # idle for two minutes
    assert eng.maybe_free_idle(30.0) is True
    assert eng._tts is None


def test_maybe_free_idle_skips_an_in_flight_synth(monkeypatch):
    """Fast-out must not block the admission path on a forward, and must not
    free a model that is mid-use."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._last_used = time.monotonic() - 120.0
    eng._synth_in_flight = 1
    assert eng.maybe_free_idle(30.0) is False
    assert eng._tts is not None


def test_maybe_free_idle_restores_the_device_preference(monkeypatch):
    """#1730 gap 3. `_ensure_loaded` overwrites `_device` with the ADMITTED
    card; only /load passes an override, so a lazy /synthesize reload reads
    `_device`. If the evict nulls `_tts` inline instead of running the full
    teardown, the next cold load pins itself to the last admitted card and
    bypasses placement entirely."""
    eng = _loaded_coqui(monkeypatch, _FakeTts())
    eng._requested_device = "auto"
    eng._device = "cuda:1"  # as _ensure_loaded would have left it
    eng._last_used = time.monotonic() - 120.0

    assert eng.maybe_free_idle(30.0) is True
    assert eng._device == "auto"
    assert eng._speakers == []
    assert eng._resolved_device == "cpu"
