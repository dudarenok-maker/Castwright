"""Smoke tests for the local TTS sidecar.

The headline test here is `test_health_responsive_during_busy_synth` — it
pins the bug fix that turned "Sidecar unreachable" red the moment generation
started. Cause: `/synthesize` was declared `async def` but did CPU-bound work
inline, blocking the event loop from accepting any new requests (including
the Node-proxy /health probe, which timed out at 2s).

Fix: offload to `asyncio.to_thread`. Test: stub the engine with a slow fake,
fire a `/synthesize` in a background thread, and assert `/health` still
responds in <500ms while it's in flight."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Optional

import pytest
from fastapi.testclient import TestClient

# Add the sidecar root to sys.path so `import main` works regardless of
# pytest's collection directory.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


class _FakeEngine(main.Engine):
    """Replaces CoquiEngine in tests so we don't load multi-gigabyte models.
    Configurable sleep simulates a slow CPU synth so the responsiveness test
    is meaningful. Optional `known_speakers` exercises the
    speaker-substitution path without requiring the real model."""

    name = "coqui"

    def __init__(self, sleep_sec: float = 0.0, known_speakers: Optional[list[str]] = None) -> None:
        self.sleep_sec = sleep_sec
        self.known_speakers = known_speakers
        self.calls: list[tuple[str, str, str]] = []

    def synthesize(self, model: str, voice: str, text: str) -> "main.SynthResult":
        self.calls.append((model, voice, text))
        if self.sleep_sec > 0:
            # time.sleep releases the GIL — but the point of the bug fix is
            # that even if it didn't, the event loop stays free because we
            # offload to a worker thread.
            time.sleep(self.sleep_sec)
        # Substitution path: if known_speakers is set and `voice` isn't in it,
        # behave like the real CoquiEngine and substitute.
        substituted_from = None
        if self.known_speakers is not None and voice not in self.known_speakers:
            substituted_from = voice
        # Trivial PCM payload: one int16 zero sample.
        return main.SynthResult(pcm=b"\x00\x00", sample_rate=24000, substituted_from=substituted_from)


@pytest.fixture
def client(monkeypatch):
    fake = _FakeEngine(sleep_sec=0.0)
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    with TestClient(main.app) as c:
        # Attach fake so tests can inspect calls.
        c.app_state_fake_engine = fake  # type: ignore[attr-defined]
        yield c


def test_health_smoke(client: TestClient) -> None:
    """/health returns the engines registry. This is the indicator the
    frontend's sidecar-pill polls — it MUST be a trivial sync route."""
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "coqui" in body["engines"]


def test_synthesize_validates_body(client: TestClient) -> None:
    """Bad inputs return 400 with a useful detail — surfaces in the Node-side
    error message and ultimately the user's chapter_failed row."""
    # Missing text.
    r = client.post("/synthesize", json={"engine": "coqui", "model": "xtts_v2", "voice": "v"})
    assert r.status_code == 400
    # Unknown engine.
    r = client.post("/synthesize", json={"engine": "nope", "model": "x", "voice": "v", "text": "hi"})
    assert r.status_code == 400
    assert "unknown engine" in r.json()["detail"].lower()


def test_synthesize_happy_path(client: TestClient) -> None:
    """A valid /synthesize returns audio/L16 PCM with the sample rate header
    set — that's the wire contract SidecarTtsProvider parses on the Node
    side. If this drifts, every generation breaks silently."""
    r = client.post(
        "/synthesize",
        json={"engine": "coqui", "model": "xtts_v2", "voice": "Narrator", "text": "Hello."},
    )
    assert r.status_code == 200
    assert r.headers["x-sample-rate"] == "24000"
    assert r.headers["content-type"].startswith("audio/L16")
    assert len(r.content) > 0


def test_health_responsive_during_busy_synth(client: TestClient) -> None:
    """The regression: while a synth is in flight, /health must still respond
    quickly. Before the to_thread fix, /synthesize blocked the event loop and
    /health probes timed out at the Node proxy's 2s ceiling, flipping the UI
    pill to "Sidecar unreachable" the moment generation started.

    Bound: /health should answer in well under 1 second even when a synth
    is mid-call (we sleep for 1.5s inside the fake). With the fix the call
    typically returns in <50ms; we leave a generous 1s ceiling so this test
    isn't flaky on slow CI."""
    fake = client.app_state_fake_engine  # type: ignore[attr-defined]
    fake.sleep_sec = 1.5

    synth_thread = threading.Thread(
        target=lambda: client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "Narrator", "text": "Hi."},
        ),
        daemon=True,
    )
    synth_thread.start()
    # Tiny grace so the synth is actually inside engine.synthesize when we probe.
    time.sleep(0.1)

    t0 = time.perf_counter()
    r = client.get("/health")
    elapsed = time.perf_counter() - t0

    assert r.status_code == 200, "health route degraded while synth was running"
    assert elapsed < 1.0, (
        f"/health took {elapsed:.3f}s during an in-flight synth — event loop "
        "is being blocked. Did /synthesize stop using asyncio.to_thread?"
    )

    synth_thread.join(timeout=5.0)
    assert not synth_thread.is_alive(), "synth thread never finished"
    assert len(fake.calls) == 1, "synth fake should have been called exactly once"


def test_synthesize_returns_substitution_header_when_voice_unknown(monkeypatch):
    """The 'index out of range in self' regression. When the Node-side voice
    catalog drifts ahead of the model's actual speaker manifest, /synthesize
    must NOT propagate XTTS's cryptic PyTorch error — it should substitute a
    safe fallback voice, complete the synth, and signal the substitution via
    a response header so the upstream can warn that its catalog is stale.

    Uses a fake engine that simulates the same substitution logic without
    requiring the real model. The actual CoquiEngine path (snapshot speakers
    at load, validate at synth time) is exercised in the production path."""
    fake = _FakeEngine(known_speakers=["Claribel Dervla", "Ana Florence"])
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "Wulf Carlevaro", "text": "Hi."},
        )
    assert r.status_code == 200, r.text
    # The synth completed (so the chapter doesn't fail), and the substitution
    # is visible in the header so the Node side can log it.
    assert r.headers.get("X-Voice-Substituted-From") == "Wulf Carlevaro"


def test_speakers_endpoint_returns_manifest(monkeypatch):
    """/speakers exposes the loaded model's speaker list — useful for
    diagnosing catalog drift without sshing into the box and poking the
    speaker manager directly."""
    fake = _FakeEngine()
    fake_speakers = ["Ana Florence", "Asya Anara", "Claribel Dervla"]
    # The fake's _speakers attribute mirrors the real CoquiEngine field. We
    # set it directly so the /speakers route reads back a known list.
    fake._speakers = fake_speakers  # type: ignore[attr-defined]
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    with TestClient(main.app) as client:
        r = client.get("/speakers")
    assert r.status_code == 200
    assert r.json() == {"coqui": fake_speakers}
