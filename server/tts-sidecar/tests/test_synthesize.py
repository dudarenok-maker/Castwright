"""Extended /synthesize coverage — validation edges, error injection, /speakers
fallbacks. Builds on the _FakeEngine + client fixture in test_smoke.py to
keep test setup uniform across the sidecar suite.

Scope note: this file covers the HTTP wire surface only. Perf-knob wiring
(COQUI_HALF / COQUI_DEEPSPEED / COQUI_DEVICE flowing through to
init_gpt_for_inference + torch.autocast) lives in test_runtime_wiring.py;
the env-var → flag decision tree lives in test_smoke.py's
test_resolve_runtime_options_* cases."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Same sys.path bootstrap as test_smoke.py so `import main` works regardless
# of pytest's collection directory.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

# Put the tests/ directory on sys.path so we can reuse _FakeEngine from
# test_smoke.py instead of duplicating it here. pytest's rootdir adjustment
# doesn't put sibling test files on the path by default on Windows.
TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from test_smoke import _FakeEngine  # noqa: E402


@pytest.fixture(autouse=True)
def _stub_poison_exit_timer(monkeypatch):
    """Safety fence for the whole module: stub `threading.Timer` so the
    poison-exit scheduler (main._schedule_poison_exit) never arms a real
    os._exit(42) that would terminate pytest mid-suite. Any test that
    needs to ASSERT on the timer must install its own monkeypatch with
    a recording stub (see the two scheduling tests below) — the autouse
    `setattr(... lambda: None)` pattern below loses to a later
    `setattr(... _FakeTimer)`, which is exactly the behaviour we want."""

    class _NoOpTimer:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def start(self) -> None:
            pass

    monkeypatch.setattr(main.threading, "Timer", _NoOpTimer)


@pytest.fixture
def client(monkeypatch):
    fake = _FakeEngine(sleep_sec=0.0)
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    with TestClient(main.app) as c:
        c.app_state_fake_engine = fake  # type: ignore[attr-defined]
        yield c


# ── /synthesize input validation ─────────────────────────────────────────

def test_synthesize_rejects_missing_engine(client: TestClient) -> None:
    """Engine field omitted entirely. The validator checks `isinstance(str)`
    AND membership in ENGINES, so a missing field falls into the same branch
    as a wrong-name field — 400 with a useful detail."""
    r = client.post("/synthesize", json={"model": "xtts_v2", "voice": "v", "text": "hi"})
    assert r.status_code == 400
    assert "unknown engine" in r.json()["detail"].lower()


def test_synthesize_rejects_missing_model(client: TestClient) -> None:
    r = client.post("/synthesize", json={"engine": "coqui", "voice": "v", "text": "hi"})
    assert r.status_code == 400
    assert "model" in r.json()["detail"].lower()


def test_synthesize_rejects_missing_voice(client: TestClient) -> None:
    r = client.post("/synthesize", json={"engine": "coqui", "model": "xtts_v2", "text": "hi"})
    assert r.status_code == 400
    assert "voice" in r.json()["detail"].lower()


def test_synthesize_rejects_empty_text(client: TestClient) -> None:
    """Whitespace-only text is treated as missing — XTTS would either crash
    or emit silence, neither of which is a useful chapter audio segment."""
    r = client.post(
        "/synthesize",
        json={"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "   "},
    )
    assert r.status_code == 400
    assert "text" in r.json()["detail"].lower()


def test_synthesize_rejects_non_string_fields(client: TestClient) -> None:
    """Type coercion bugs upstream shouldn't reach the engine — bail at the
    boundary so the error message points at the right layer."""
    r = client.post(
        "/synthesize",
        json={"engine": "coqui", "model": 42, "voice": "v", "text": "hi"},
    )
    assert r.status_code == 400


def test_synthesize_rejects_non_json_body(client: TestClient) -> None:
    """The route wraps `await req.json()` in try/except → 400 with the
    canonical message. Without that wrap, FastAPI would 422 the request and
    the Node side would log a confusing JSONDecodeError trace."""
    r = client.post(
        "/synthesize",
        data="not-json",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400
    assert "json" in r.json()["detail"].lower()


# ── /synthesize error injection ──────────────────────────────────────────

def test_synthesize_returns_500_when_engine_raises(monkeypatch) -> None:
    """If the engine itself blows up (model load failed, OOM, whatever),
    /synthesize must return 500 with the exception message — otherwise the
    Node side has no signal to flip the chapter to chapter_failed."""

    class _ExplodingEngine(_FakeEngine):
        def synthesize(self, model: str, voice: str, text: str):
            raise RuntimeError("model load went sideways")

    monkeypatch.setitem(main.ENGINES, "coqui", _ExplodingEngine())
    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "hi"},
        )
    assert r.status_code == 500
    assert "model load went sideways" in r.json()["detail"]


# ── CUDA poison fence ────────────────────────────────────────────────────

def test_synthesize_schedules_process_exit_on_cuda_assert(monkeypatch) -> None:
    """The first poisoned synth must arm a deferred os._exit(_POISON_EXIT_CODE)
    on a background thread so the start.ps1 supervisor sees the sidecar
    die with the agreed code and respawns it. Without this, the sidecar
    sits with a corrupted CUDA context fast-failing 503 forever until the
    user manually kills it.

    We replace `threading.Timer` (the scheduler the production code uses)
    with a fake that records calls but never actually exits the test
    process — otherwise asserting on the timer would terminate pytest."""
    timer_calls: list[tuple[float, Any]] = []

    class _FakeTimer:
        def __init__(self, delay: float, fn: Any) -> None:
            timer_calls.append((delay, fn))

        def start(self) -> None:
            pass

    monkeypatch.setattr(main.threading, "Timer", _FakeTimer)

    class _CudaPoisonedEngine(_FakeEngine):
        def synthesize(self, model: str, voice: str, text: str):
            raise RuntimeError("CUDA error: device-side assert triggered")

    engine = _CudaPoisonedEngine()
    monkeypatch.setitem(main.ENGINES, "coqui", engine)
    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "hi"},
        )
    assert r.status_code == 503
    assert engine._poisoned is True
    assert engine._exit_scheduled is True
    # Exactly one timer scheduled; the delay matches the configured ms.
    assert len(timer_calls) == 1
    delay, _fn = timer_calls[0]
    assert delay == main._POISON_EXIT_DELAY_MS / 1000.0


def test_synthesize_does_not_double_schedule_exit_on_concurrent_poison(monkeypatch) -> None:
    """If two requests race into the poison branch (chapter 1 + chapter 2
    both in flight when the assert fires), the second one must NOT arm a
    second exit timer — the supervisor only respawns once, so a second
    timer would either no-op (good) or risk an os._exit fight (bad)."""
    timer_calls: list[tuple[float, Any]] = []

    class _FakeTimer:
        def __init__(self, delay: float, fn: Any) -> None:
            timer_calls.append((delay, fn))

        def start(self) -> None:
            pass

    monkeypatch.setattr(main.threading, "Timer", _FakeTimer)

    class _CudaPoisonedEngine(_FakeEngine):
        def synthesize(self, model: str, voice: str, text: str):
            raise RuntimeError("CUDA error: device-side assert triggered")

    engine = _CudaPoisonedEngine()
    monkeypatch.setitem(main.ENGINES, "coqui", engine)
    with TestClient(main.app) as client:
        # First request flags poison + schedules exit.
        client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "hi"},
        )
        # Second request — the fast-fail fence at the top of /synthesize
        # short-circuits with 503 BEFORE re-entering the synth path, so
        # the engine.synthesize hook never re-throws. Even if it did,
        # _exit_scheduled is already true. Either way: still exactly one
        # timer.
        client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "hi"},
        )
    assert len(timer_calls) == 1


def test_synthesize_flags_engine_as_poisoned_on_cuda_assert(monkeypatch) -> None:
    """A `CUDA error: device-side assert triggered` corrupts the whole CUDA
    context for the lifetime of the process — no recovery short of a
    sidecar restart will get further /synthesize calls working. The route
    must (a) return 503 (not 500) with `"poisoned": true` in the body so
    the Node classifier can surface a "restart" banner, and (b) set the
    engine's _poisoned flag so subsequent /synthesize calls fast-fail
    without re-triggering the failing inference."""

    class _CudaPoisonedEngine(_FakeEngine):
        def synthesize(self, model: str, voice: str, text: str):
            raise RuntimeError(
                "CUDA error: device-side assert triggered\n"
                "CUDA kernel errors might be asynchronously reported…"
            )

    engine = _CudaPoisonedEngine()
    monkeypatch.setitem(main.ENGINES, "coqui", engine)
    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "hi"},
        )
    assert r.status_code == 503
    body = r.json()
    assert body.get("poisoned") is True
    assert "device-side assert" in body["detail"].lower()
    # Engine must self-flag so cross-request fence works on call #2.
    assert engine._poisoned is True
    assert engine._poison_reason is not None and "device-side assert" in engine._poison_reason


def test_synthesize_fast_fails_503_when_engine_already_poisoned(monkeypatch) -> None:
    """Once _poisoned is set, the route MUST refuse to call .synthesize()
    again — re-entering would either replay the same CUDA error (wasting
    seconds on a guaranteed failure) or worse, mutate Python-level state
    on the doomed context. The fast-fail path returns the same 503 shape
    so the Node classifier sees consistent error JSON across attempts."""

    class _SpyEngine(_FakeEngine):
        def __init__(self) -> None:
            super().__init__()
            self.call_count = 0

        def synthesize(self, model: str, voice: str, text: str):
            self.call_count += 1
            return super().synthesize(model, voice, text)

    engine = _SpyEngine()
    engine._poisoned = True
    engine._poison_reason = "CUDA error: device-side assert triggered (synthetic)"
    monkeypatch.setitem(main.ENGINES, "coqui", engine)

    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "v", "text": "hi"},
        )
    assert r.status_code == 503
    body = r.json()
    assert body.get("poisoned") is True
    assert "restart" in body["detail"].lower()
    # The crucial assertion: the engine's synthesize was NEVER invoked.
    assert engine.call_count == 0


def test_health_reports_poisoned_flag(monkeypatch) -> None:
    """/health surfaces `poisoned: true` once an engine is flagged so the
    in-app Load/Stop pill can render a "needs restart" state. Without this,
    the pill would still say "ready" while every /synthesize fast-fails 503
    — a confusing mixed signal for the user."""
    engine = _FakeEngine()
    engine._tts = object()  # sentinel: model is "loaded"
    engine._resolved_device = "cuda"
    engine._poisoned = True
    engine._poison_reason = "CUDA error: device-side assert triggered"
    monkeypatch.setitem(main.ENGINES, "coqui", engine)
    with TestClient(main.app) as client:
        r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["poisoned"] is True
    assert "device-side assert" in body["poison_reason"]


# ── /synthesize wire format ──────────────────────────────────────────────

def test_synthesize_returns_pcm_payload_with_matching_rate_header(client: TestClient) -> None:
    """The Node side reads x-sample-rate to set up the WAV header for the
    output buffer. If the rate value drifts from the actual PCM, every chapter
    plays at the wrong pitch — a silent class of failure."""
    r = client.post(
        "/synthesize",
        json={"engine": "coqui", "model": "xtts_v2", "voice": "Narrator", "text": "Hi."},
    )
    assert r.status_code == 200
    # _FakeEngine returns a 2-byte int16 zero sample at 24 kHz.
    assert r.headers["x-sample-rate"] == "24000"
    assert r.headers["content-type"] == "audio/L16;codec=pcm;rate=24000"
    assert r.content == b"\x00\x00"


def test_synthesize_omits_substitution_header_on_exact_match(client: TestClient) -> None:
    """When the requested voice IS in the speaker manifest, no substitution
    header — otherwise the Node side would warn on a clean run."""
    fake = client.app_state_fake_engine  # type: ignore[attr-defined]
    fake.known_speakers = ["Narrator"]
    r = client.post(
        "/synthesize",
        json={"engine": "coqui", "model": "xtts_v2", "voice": "Narrator", "text": "Hi."},
    )
    assert r.status_code == 200
    assert "X-Voice-Substituted-From" not in r.headers
    assert "x-voice-substituted-from" not in {k.lower() for k in r.headers}


# ── /speakers fallbacks ──────────────────────────────────────────────────

def test_speakers_returns_empty_when_coqui_engine_absent(monkeypatch) -> None:
    """If the coqui engine isn't registered at all, /speakers returns {}
    rather than 500 — the Node-side diagnostics tooling polls this and a
    crash here would mask the real "model didn't load" problem."""
    monkeypatch.setattr(main, "ENGINES", {})
    with TestClient(main.app) as client:
        r = client.get("/speakers")
    assert r.status_code == 200
    assert r.json() == {}


def test_speakers_returns_empty_list_before_model_loaded(monkeypatch) -> None:
    """A CoquiEngine that hasn't loaded a model yet has `_speakers == []` —
    the route surfaces that as a known-empty list, not an error. This is the
    state during startup before /synthesize triggers the lazy load."""
    fake = _FakeEngine()
    # Fresh CoquiEngine subclass starts with _speakers = [].
    assert fake._speakers == []
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    with TestClient(main.app) as client:
        r = client.get("/speakers")
    assert r.status_code == 200
    assert r.json() == {"coqui": []}
