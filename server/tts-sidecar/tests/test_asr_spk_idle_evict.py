"""ASR + ECAPA unload/infer race (#1894, found during its review).

Both engines hold `_infer_lock` across their forward but their `unload()`
never acquires it, and `maybe_free_idle` calls `unload()` directly. Since both
are already driven by `_idle_evict_steps(0.0)`, an admission-path evict can null the
model mid-forward. Same defect the Coqui work fixed, one layer over.

Round-1 review (#1894) added two further pins:
  - the `unload_waits` tests assert from INSIDE the forward, not by timing
    `unload()` — timing `_reclaim_host_and_vram()`'s first-ever torch import
    + CUDA init is not a reliable proxy for "was blocked" (it can simply be
    slow, in either direction, on either engine).
  - `maybe_free_idle` needs a THIRD leg mirroring `CoquiEngine`: re-validate
    `_in_flight` (not just `self._model`) under the lock, not only via
    the lock-free fast-out. Without it, a counter that goes from 0 -> 1 while
    `maybe_free_idle` is queued on the lock is invisible to it, and it evicts
    a model a forward has already claimed. `_in_flight` is an `InFlightCounter`
    (#1917), not a plain int — see main.py.
"""
import importlib, os, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")


def test_asr_unload_waits_for_an_in_flight_transcribe(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    observed: dict[str, bool] = {}

    class _FakeModel:
        def transcribe(self, audio, **kw):
            entered.set()
            release.wait(timeout=5)
            # Read at the END of the forward, after unload() has had its 0.3 s
            # window: with the fix it is still queued on `_infer_lock`, so the
            # model must still be live. Deterministic in BOTH directions —
            # unfixed, unload() nulls `_model` as its FIRST action, long before
            # the slow reclaim, so this reads None and the test fails.
            observed["alive"] = eng._model is not None
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
    # Liveness check only — a coarse signal, not the discriminator (that's
    # `observed["alive"]` below, which doesn't depend on reclaim timing).
    assert not freed.wait(timeout=0.3), "unload() did not wait for the forward"

    release.set()
    t.join(timeout=5)
    u.join(timeout=5)
    assert errors == [], f"transcribe raised while unload raced it: {errors!r}"
    assert observed.get("alive") is True, "unload() nulled the model mid-forward"
    assert eng._model is None


def test_asr_transcribe_restamps_last_used_before_the_in_flight_drop(monkeypatch):
    """ASR twin of `CoquiEngine`'s
    `test_synthesize_restamps_last_used_before_the_in_flight_drop` (#1917
    Global Constraint): the `_last_used` re-stamp on the way out must happen
    BEFORE the in-flight claim's own decrement, never after — see that test
    for the full rationale — including why the sentinel MUST be zeroed from
    inside the forward rather than before the call. `transcribe` stamps
    `_last_used` both on the way in and again under `_infer_lock`, so a
    sentinel set before the call is overwritten twice before the forward
    ends and the assertion would hold under either ordering.

    Observes `_last_used` AT THE MOMENT of each in-flight-lock acquire via an
    injectable lock; `stamps == [entry-time, exit-time]` for a single call."""
    eng = main.WhisperEngine()
    monkeypatch.setattr(eng, "_ensure_loaded", lambda device=None: None)
    monkeypatch.setattr(eng, "_pcm_to_float32_16k", lambda pcm, sr: [0.0])

    def _fake_transcribe(self, audio, **kw):
        # Last write before the forward returns — see the docstring.
        eng._last_used = 0.0
        return ([], type("I", (), {"language": "en"})())

    eng._model = type("M", (), {"transcribe": _fake_transcribe})()

    class RecordingLock:
        def __init__(self):
            self._l = threading.Lock()
            self.stamps: list[float] = []

        def __enter__(self):
            self._l.acquire()
            self.stamps.append(eng._last_used)
            return self

        def __exit__(self, *a):
            self._l.release()
            return False

    lock = RecordingLock()
    eng._in_flight = main.InFlightCounter(lock=lock)

    eng.transcribe(b"\x00\x00", 16000)

    # Sentinel rather than a strict `>` against a freshly sampled clock —
    # ~15.6 ms monotonic granularity on Python 3.12/Windows.
    assert lock.stamps[1] > 0.0, (
        "`_last_used` still read the in-forward sentinel when the in-flight "
        "count dropped — the re-stamp ran AFTER the decrement"
    )


def test_asr_maybe_free_idle_skips_an_in_flight_transcribe(monkeypatch):
    """The fast-out must exist, or admission blocks on the whole forward."""
    eng = main.WhisperEngine()
    eng._model = object()
    eng._last_used = time.monotonic() - 600.0  # long idle
    claim = eng._in_flight.claim()
    claim.__enter__()  # hold a real claim open, mirroring an in-flight forward
    try:
        assert eng.maybe_free_idle(120.0) is False
        assert eng._model is not None
    finally:
        claim.__exit__(None, None, None)


def test_asr_maybe_free_idle_reevaluates_the_counter_under_the_lock(monkeypatch):
    """Distinct from the plain fast-out test above: the counter is still 0
    when `maybe_free_idle`'s lock-free check runs (so that check alone can't
    stop it), and only becomes 1 while `_infer_lock` is held by someone else
    — pinning the re-validate-under-the-lock leg, not the cheap one."""
    eng = main.WhisperEngine()
    eng._model = object()
    eng._last_used = time.monotonic() - 600.0  # long idle
    assert eng._in_flight.value == 0  # the InFlightCounter's own default

    lock_acquired = threading.Event()
    set_counter = threading.Event()
    counter_set = threading.Event()
    holder_release = threading.Event()

    def holder():
        with eng._infer_lock:
            lock_acquired.set()
            set_counter.wait(timeout=5)
            eng._in_flight._n = 1  # simulate a concurrent forward's claim
            counter_set.set()
            holder_release.wait(timeout=5)

    h = threading.Thread(target=holder)
    h.start()
    assert lock_acquired.wait(timeout=5), "holder never acquired the lock"

    result: dict[str, bool] = {}
    done = threading.Event()

    def run_evict():
        result["freed"] = eng.maybe_free_idle(120.0)
        done.set()

    e = threading.Thread(target=run_evict)
    e.start()
    # The lock-free fast-out saw counter==0 and passed; maybe_free_idle can
    # only be queued on `_infer_lock` now (held by `holder`), not stopped by
    # the cheap check.
    assert not done.wait(timeout=0.3), "maybe_free_idle finished before the lock was released"

    set_counter.set()
    assert counter_set.wait(timeout=5), "holder never set the counter"
    holder_release.set()

    h.join(timeout=5)
    e.join(timeout=5)
    assert result.get("freed") is False, "maybe_free_idle dropped a model claimed under the lock"
    assert eng._model is not None


def test_spk_unload_waits_for_an_in_flight_embed(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    observed: dict[str, bool] = {}

    class _FakeEncoder:
        def encode_batch(self, t):
            entered.set()
            release.wait(timeout=5)
            observed["alive"] = eng._model is not None
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
    # Liveness check only — a coarse signal, not the discriminator (that's
    # `observed["alive"]` below, which doesn't depend on reclaim timing).
    assert not freed.wait(timeout=0.3), "unload() did not wait for the forward"

    release.set()
    t.join(timeout=5)
    u.join(timeout=5)
    assert errors == [], f"embed raised while unload raced it: {errors!r}"
    assert observed.get("alive") is True, "unload() nulled the model mid-forward"
    assert eng._model is None


def test_spk_embed_restamps_last_used_before_the_in_flight_drop(monkeypatch):
    """SPK twin of `CoquiEngine`'s
    `test_synthesize_restamps_last_used_before_the_in_flight_drop` (#1917
    Global Constraint) — see that test for the full rationale, including why
    the sentinel MUST be zeroed from inside the forward: `embed` stamps
    `_last_used` on the way in, so a sentinel set before the call is gone
    before `encode_batch` runs and the assertion would hold under either
    ordering. `stamps == [entry-time, exit-time]`."""
    import numpy as np

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

    class _FakeEncoder:
        def encode_batch(self, t):
            # Last write before the forward returns — see the docstring.
            eng._last_used = 0.0
            return _FakeOut(np.ones((1, 4), dtype="float32"))

    eng = main.SpeakerEngine()
    eng._model = _FakeEncoder()

    class RecordingLock:
        def __init__(self):
            self._l = threading.Lock()
            self.stamps: list[float] = []

        def __enter__(self):
            self._l.acquire()
            self.stamps.append(eng._last_used)
            return self

        def __exit__(self, *a):
            self._l.release()
            return False

    lock = RecordingLock()
    eng._in_flight = main.InFlightCounter(lock=lock)

    eng.embed(b"\x00\x00" * 160, 16000)

    # Sentinel rather than a strict `>` against a freshly sampled clock —
    # ~15.6 ms monotonic granularity on Python 3.12/Windows.
    assert lock.stamps[1] > 0.0, (
        "`_last_used` still read the in-forward sentinel when the in-flight "
        "count dropped — the re-stamp ran AFTER the decrement"
    )


def test_spk_maybe_free_idle_skips_an_in_flight_embed(monkeypatch):
    eng = main.SpeakerEngine()
    monkeypatch.setattr(main, "_parse_device", lambda d: ("cuda", 0))
    eng._model = object()
    eng._last_used = time.monotonic() - 600.0
    claim = eng._in_flight.claim()
    claim.__enter__()  # hold a real claim open, mirroring an in-flight forward
    try:
        assert eng.maybe_free_idle(120.0) is False
        assert eng._model is not None
    finally:
        claim.__exit__(None, None, None)


def test_spk_maybe_free_idle_reevaluates_the_counter_under_the_lock(monkeypatch):
    """SPK twin of the ASR test above: the counter is still 0 when the
    lock-free fast-out runs, and only becomes 1 while `_infer_lock` is held
    by someone else."""
    eng = main.SpeakerEngine()
    monkeypatch.setattr(main, "_parse_device", lambda d: ("cuda", 0))
    eng._model = object()
    eng._last_used = time.monotonic() - 600.0
    assert eng._in_flight.value == 0  # the InFlightCounter's own default

    lock_acquired = threading.Event()
    set_counter = threading.Event()
    counter_set = threading.Event()
    holder_release = threading.Event()

    def holder():
        with eng._infer_lock:
            lock_acquired.set()
            set_counter.wait(timeout=5)
            eng._in_flight._n = 1  # simulate a concurrent forward's claim
            counter_set.set()
            holder_release.wait(timeout=5)

    h = threading.Thread(target=holder)
    h.start()
    assert lock_acquired.wait(timeout=5), "holder never acquired the lock"

    result: dict[str, bool] = {}
    done = threading.Event()

    def run_evict():
        result["freed"] = eng.maybe_free_idle(120.0)
        done.set()

    e = threading.Thread(target=run_evict)
    e.start()
    assert not done.wait(timeout=0.3), "maybe_free_idle finished before the lock was released"

    set_counter.set()
    assert counter_set.wait(timeout=5), "holder never set the counter"
    holder_release.set()

    h.join(timeout=5)
    e.join(timeout=5)
    assert result.get("freed") is False, "maybe_free_idle dropped a model claimed under the lock"
    assert eng._model is not None
