"""Extended /synthesize coverage — validation edges, error injection, /speakers
fallbacks. Builds on the _FakeEngine + client fixture in test_smoke.py to
keep test setup uniform across the sidecar suite.

Scope note: these tests deliberately stay off the sidecar's perf knobs
(COQUI_HALF, COQUI_DEEPSPEED, COQUI_DEVICE) — DeepSpeed enablement is in
flight in a separate work stream, and the existing
test_resolve_runtime_options_* tests already pin the decision tree."""
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
