"""test_concurrent_synthesis.py — thread-pool saturation under parallel /synthesize.

The single-request paths in test_synthesize.py and test_runtime_wiring.py
pin the synth pipeline, but the route's `asyncio.to_thread` offload means
N concurrent /synthesize calls share Python's default ThreadPoolExecutor.
A regression that swapped the to_thread out, or that introduced shared
mutable state inside an engine, would silently corrupt audio under load
— exactly the class of bug that escapes single-request coverage. The
nearest precedent in the suite, `test_health_responsive_during_busy_synth`
in test_smoke.py, pins the bug fix that motivates this whole file:
removing the to_thread once before flipped /health to "unreachable" on
every generation. These tests extend the contract to parallel /synthesize
calls themselves.

Assertions under load:
- Concurrent requests actually run in parallel (wall-clock ≈ single-call
  time, not N × single-call time).
- Each response carries its own PCM (no cross-request bleed where one
  request's text returns another's audio).
- The sample-rate header matches the PCM body for every response.
- Substitution decisions are per-request (one request's known-good
  voice doesn't trip another's substitution header, and vice versa).

Coqui and Kokoro have independent engine instances and per-engine
fallback/substitution paths, so a thread-pool regression could land on
either; each is covered separately.

Uses fakes — does NOT load real models. Mocks make the test fast and
GPU-independent; the real CUDA + DeepSpeed + fp16 wiring is already
pinned by test_runtime_wiring.py.
"""
from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# ── PCM round-trip helpers ────────────────────────────────────────────

def _text_to_pcm(text: str) -> bytes:
    """Deterministic, per-call PCM derived from the input text so
    cross-bleed assertions can prove each response carries its OWN audio.
    Encodes each character as one int16 LE sample (low byte first). The
    exact shape is arbitrary — only the "this PCM came from this text"
    round-trip matters."""
    if not text:
        return b"\x00\x00"
    out = bytearray()
    for c in text:
        sample = ord(c) & 0x7FFF  # stay within int16 positive range
        out.append(sample & 0xFF)
        out.append((sample >> 8) & 0xFF)
    return bytes(out)


def _pcm_to_first_char(pcm: bytes) -> Optional[str]:
    """Inverse of `_text_to_pcm`'s first sample: read the first int16 LE
    sample back to its original character. Used to verify a response's
    payload came from THIS request, not a sibling on the thread pool."""
    if len(pcm) < 2:
        return None
    value = (pcm[1] << 8) | pcm[0]
    return chr(value)


# ── Fake engines that emit text-derived PCM + track concurrency ───────

class _FakeCoquiEngine(main.CoquiEngine):
    """Thread-safe fake — every `synthesize` call sleeps for `sleep_sec`
    and returns text-encoded PCM. Tracks peak in-flight count so the
    concurrency proof can assert the thread pool actually overlapped
    calls (the wall-clock check alone could be satisfied by a fast
    enough box even without parallelism)."""

    name = "coqui"

    def __init__(self, sleep_sec: float = 0.05, known_speakers: Optional[list[str]] = None) -> None:
        super().__init__()
        self.sleep_sec = sleep_sec
        self.known_speakers = known_speakers
        self._calls_lock = threading.Lock()
        self.calls: list[tuple[str, str, str]] = []
        self._inflight_lock = threading.Lock()
        self._inflight = 0
        self.peak_inflight = 0

    def synthesize(self, model: str, voice: str, text: str) -> "main.SynthResult":
        with self._inflight_lock:
            self._inflight += 1
            if self._inflight > self.peak_inflight:
                self.peak_inflight = self._inflight
        try:
            with self._calls_lock:
                self.calls.append((model, voice, text))
            # time.sleep releases the GIL — sibling worker-threads can
            # progress while we're parked here, which is the whole point.
            if self.sleep_sec > 0:
                time.sleep(self.sleep_sec)
            substituted_from = None
            if self.known_speakers is not None and voice not in self.known_speakers:
                substituted_from = voice
            return main.SynthResult(
                pcm=_text_to_pcm(text),
                sample_rate=24000,
                substituted_from=substituted_from,
            )
        finally:
            with self._inflight_lock:
                self._inflight -= 1


class _FakeKokoroEngine(main.KokoroEngine):
    """Same protocol as `_FakeCoquiEngine` against the Kokoro slot.
    Independent class so the route handler's `isinstance(engine,
    KokoroEngine)` gates (and any future Kokoro-only branches) resolve
    correctly."""

    name = "kokoro"

    def __init__(self, sleep_sec: float = 0.05) -> None:
        super().__init__()
        self.sleep_sec = sleep_sec
        self._calls_lock = threading.Lock()
        self.calls: list[tuple[str, str, str]] = []
        self._inflight_lock = threading.Lock()
        self._inflight = 0
        self.peak_inflight = 0

    def synthesize(self, model: str, voice: str, text: str) -> "main.SynthResult":
        with self._inflight_lock:
            self._inflight += 1
            if self._inflight > self.peak_inflight:
                self.peak_inflight = self._inflight
        try:
            with self._calls_lock:
                self.calls.append((model, voice, text))
            if self.sleep_sec > 0:
                time.sleep(self.sleep_sec)
            return main.SynthResult(
                pcm=_text_to_pcm(text),
                sample_rate=self.NATIVE_SAMPLE_RATE,
                substituted_from=None,
            )
        finally:
            with self._inflight_lock:
                self._inflight -= 1


@pytest.fixture
def coqui_client(monkeypatch):
    fake = _FakeCoquiEngine(sleep_sec=0.05, known_speakers=["Narrator", "Other"])
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    with TestClient(main.app) as c:
        c.app_state_fake_engine = fake  # type: ignore[attr-defined]
        yield c


@pytest.fixture
def kokoro_client(monkeypatch):
    fake = _FakeKokoroEngine(sleep_sec=0.05)
    monkeypatch.setitem(main.ENGINES, "kokoro", fake)
    with TestClient(main.app) as c:
        c.app_state_fake_engine = fake  # type: ignore[attr-defined]
        yield c


# ── Parallel-call helper ──────────────────────────────────────────────

def _post_synthesize_concurrent(
    client: TestClient,
    engine_id: str,
    model: str,
    voice: str,
    texts: list[str],
) -> list[tuple[str, int, str, bytes]]:
    """Fire N /synthesize calls in parallel from a thread pool and return
    (text, status, sample-rate-header, body) tuples in completion order.

    `TestClient.post` is sync; the route's `asyncio.to_thread` offload
    only matters under parallel inbound traffic. The existing
    `test_health_responsive_during_busy_synth` in test_smoke.py uses the
    same multi-OS-thread pattern against the same TestClient — that's
    the precedent."""
    def _call(text: str) -> tuple[str, int, str, bytes]:
        r = client.post(
            "/synthesize",
            json={"engine": engine_id, "model": model, "voice": voice, "text": text},
        )
        return text, r.status_code, r.headers.get("x-sample-rate", ""), r.content

    results: list[tuple[str, int, str, bytes]] = []
    with ThreadPoolExecutor(max_workers=len(texts)) as pool:
        futures = [pool.submit(_call, t) for t in texts]
        for fut in as_completed(futures):
            results.append(fut.result())
    return results


# ── Coqui concurrency ─────────────────────────────────────────────────

def test_coqui_concurrent_synthesize_runs_in_parallel(coqui_client: TestClient) -> None:
    """N concurrent /synthesize calls against the Coqui slot must complete
    in wall-clock close to single-call time, NOT N × single-call time.
    Proves the route's `asyncio.to_thread` offload fans out to the worker
    pool rather than serialising on the event loop. The wall-clock bound
    is generous (0.9 s for 4 × 0.3 s) to absorb thread-startup overhead
    on slow CI; the real parallel target is ~0.35 s."""
    fake = coqui_client.app_state_fake_engine  # type: ignore[attr-defined]
    fake.sleep_sec = 0.3
    texts = ["alpha", "bravo", "charlie", "delta"]

    t0 = time.perf_counter()
    results = _post_synthesize_concurrent(coqui_client, "coqui", "xtts_v2", "Narrator", texts)
    elapsed = time.perf_counter() - t0

    assert all(status == 200 for (_t, status, _r, _p) in results), (
        f"some calls failed under parallel load: "
        f"{[(t, s) for (t, s, _, _) in results]}"
    )
    assert elapsed < 0.9, (
        f"4 concurrent /synthesize calls took {elapsed:.3f}s — should be "
        f"≈ 0.3s (per-call sleep) not 1.2s (serial). asyncio.to_thread "
        "offload may have regressed."
    )
    # Peak in-flight > 1 confirms the pool actually overlapped requests.
    # Without this, a fast box could satisfy the wall-clock bound even
    # under accidental serialisation.
    assert fake.peak_inflight >= 2, (
        f"peak in-flight was {fake.peak_inflight}; expected >=2 to confirm "
        "the thread pool actually overlapped requests"
    )


def test_coqui_concurrent_no_cross_request_bleed(coqui_client: TestClient) -> None:
    """Each response's PCM must encode the text from THAT request, not a
    sibling's. If the engine held shared mutable state (a class-level
    audio buffer, say), two concurrent requests could swap payloads. The
    text-derived PCM (`_text_to_pcm`) makes the swap visible: decode the
    first sample, compare to the request's first character."""
    fake = coqui_client.app_state_fake_engine  # type: ignore[attr-defined]
    fake.sleep_sec = 0.1
    texts = ["Aaron", "Bella", "Cyrus", "Daria"]

    results = _post_synthesize_concurrent(coqui_client, "coqui", "xtts_v2", "Narrator", texts)
    assert {text for (text, _s, _r, _p) in results} == set(texts), "request set lost"

    for (text, status, rate, pcm) in results:
        assert status == 200, f"{text}: {status}"
        first_char = _pcm_to_first_char(pcm)
        assert first_char == text[0], (
            f"response for {text!r} carried PCM whose first sample decoded to "
            f"{first_char!r}; expected {text[0]!r}. Cross-request bleed detected."
        )
        assert rate == "24000", f"{text}: sample rate {rate!r}"


def test_coqui_concurrent_substitution_is_per_request(coqui_client: TestClient) -> None:
    """Voice substitution is decided per-call based on `known_speakers`.
    Under parallel load, a request with a known voice must NOT pick up
    the `X-Voice-Substituted-From` header from a sibling that DID
    substitute, and vice versa. Asserts the header-emission path is
    sourced from per-response state, not engine-level."""
    fake = coqui_client.app_state_fake_engine  # type: ignore[attr-defined]
    fake.sleep_sec = 0.1

    pairs = [
        ("Narrator", "a-known"),
        ("UnknownVoice", "b-substituted"),
        ("Other", "c-known"),
        ("AlsoUnknown", "d-substituted"),
    ]

    def _call(args: tuple[str, str]) -> tuple[str, str, Optional[str]]:
        voice, text = args
        r = coqui_client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": voice, "text": text},
        )
        return voice, text, r.headers.get("X-Voice-Substituted-From")

    with ThreadPoolExecutor(max_workers=len(pairs)) as pool:
        out = list(pool.map(_call, pairs))

    by_text = {t: (v, sub) for (v, t, sub) in out}
    assert by_text["a-known"][1] is None, "known voice should not get a substitution header"
    assert by_text["b-substituted"][1] == "UnknownVoice", (
        "unknown voice should report itself in the substitution header"
    )
    assert by_text["c-known"][1] is None, "second known voice should also skip the header"
    assert by_text["d-substituted"][1] == "AlsoUnknown", "second unknown voice should report itself"


# ── Kokoro concurrency (independent engine instance) ──────────────────

def test_kokoro_concurrent_synthesize_runs_in_parallel(kokoro_client: TestClient) -> None:
    """Kokoro's engine instance is independent of Coqui's; a thread-pool
    regression could land on either. Same wall-clock proof against the
    Kokoro slot."""
    fake = kokoro_client.app_state_fake_engine  # type: ignore[attr-defined]
    fake.sleep_sec = 0.3
    texts = ["one", "two", "three", "four"]

    t0 = time.perf_counter()
    results = _post_synthesize_concurrent(kokoro_client, "kokoro", "v1", "af_heart", texts)
    elapsed = time.perf_counter() - t0

    assert all(status == 200 for (_t, status, _r, _p) in results)
    assert elapsed < 0.9, (
        f"4 concurrent Kokoro /synthesize calls took {elapsed:.3f}s — should be "
        f"≈ 0.3s (per-call sleep). asyncio.to_thread offload may have regressed."
    )
    assert fake.peak_inflight >= 2


def test_kokoro_concurrent_no_cross_request_bleed(kokoro_client: TestClient) -> None:
    """Kokoro equivalent of the Coqui cross-bleed assertion. Each response's
    PCM must decode back to its own request's text."""
    fake = kokoro_client.app_state_fake_engine  # type: ignore[attr-defined]
    fake.sleep_sec = 0.1
    texts = ["Pebble", "Quokka", "Raven", "Sable"]

    results = _post_synthesize_concurrent(kokoro_client, "kokoro", "v1", "af_heart", texts)
    assert {text for (text, _s, _r, _p) in results} == set(texts)

    for (text, status, rate, pcm) in results:
        assert status == 200, f"{text}: {status}"
        first_char = _pcm_to_first_char(pcm)
        assert first_char == text[0], (
            f"response for {text!r} carried PCM whose first sample decoded to "
            f"{first_char!r}; expected {text[0]!r}"
        )
        assert rate == str(_FakeKokoroEngine.NATIVE_SAMPLE_RATE)


def test_kokoro_same_input_twice_is_deterministic(kokoro_client: TestClient) -> None:
    """Same input → identical PCM, twice (plan 107 determinism pin).

    Within-chapter sentence parallelism (server-side, plan 107) fans a single
    chapter's sentence groups out to concurrent /synthesize calls, then
    concatenates the PCM back in narrative order. That reorder is only sound
    if a given (model, voice, text) request always returns byte-identical
    audio regardless of when or alongside what it runs — otherwise the
    parallel-vs-serial output could diverge. This pins the contract at the
    sidecar boundary: the SAME input synthesised twice (here serially, but
    the engine holds no per-call mutable state, which the parallel
    no-cross-bleed tests above already exercise) yields identical PCM and the
    same sample-rate header. A regression that introduced run-to-run
    nondeterminism (e.g. an unseeded sampler, a shared scratch buffer) would
    surface here and would silently corrupt parallel chapter audio."""
    text = "The same line, synthesised twice."
    first = kokoro_client.post(
        "/synthesize",
        json={"engine": "kokoro", "model": "v1", "voice": "af_heart", "text": text},
    )
    second = kokoro_client.post(
        "/synthesize",
        json={"engine": "kokoro", "model": "v1", "voice": "af_heart", "text": text},
    )

    assert first.status_code == 200 and second.status_code == 200
    assert first.content == second.content, (
        "same input produced different PCM across two calls — Kokoro synth is "
        "nondeterministic, which would corrupt plan-107 parallel chapter audio"
    )
    assert first.headers.get("x-sample-rate") == second.headers.get("x-sample-rate")
    # And the PCM actually round-trips back to this request's text (not empty
    # / not a sibling's) — guards against a degenerate "always returns b''"
    # engine trivially passing the equality check above.
    assert _pcm_to_first_char(first.content) == text[0]


def test_concurrent_sample_rate_header_matches_per_response(kokoro_client: TestClient) -> None:
    """Sample-rate header is computed per-response from `result.sample_rate`.
    Under parallel load, each request's header must match THAT response's
    rate, not a sibling's. Patches the fake to vary the rate by text
    length so a header swap is unambiguous."""
    fake = kokoro_client.app_state_fake_engine  # type: ignore[attr-defined]
    fake.sleep_sec = 0.05

    original = fake.synthesize
    def _variable_rate_synth(model: str, voice: str, text: str) -> "main.SynthResult":
        res = original(model, voice, text)
        # 16000 + 1000 × len(text) keeps rates legal-ish and per-text-unique.
        return main.SynthResult(
            pcm=res.pcm,
            sample_rate=16000 + len(text) * 1000,
            substituted_from=res.substituted_from,
        )
    fake.synthesize = _variable_rate_synth  # type: ignore[assignment]

    pairs = [("aa", 18000), ("bbbb", 20000), ("cccccc", 22000)]

    def _call(text: str) -> tuple[str, str]:
        r = kokoro_client.post(
            "/synthesize",
            json={"engine": "kokoro", "model": "v1", "voice": "af_heart", "text": text},
        )
        return text, r.headers.get("x-sample-rate", "")

    with ThreadPoolExecutor(max_workers=len(pairs)) as pool:
        out = list(pool.map(lambda p: _call(p[0]), pairs))

    by_text = {t: rate for (t, rate) in out}
    for text, expected in pairs:
        assert by_text[text] == str(expected), (
            f"response for {text!r} carried sample-rate header {by_text[text]!r}, "
            f"expected {expected}. Header may have cross-bled from a sibling."
        )
