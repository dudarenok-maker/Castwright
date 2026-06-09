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


class _FakeEngine(main.CoquiEngine):
    """Replaces CoquiEngine in tests so we don't load multi-gigabyte models.
    Configurable sleep simulates a slow CPU synth so the responsiveness test
    is meaningful. Optional `known_speakers` exercises the
    speaker-substitution path without requiring the real model.

    Subclasses CoquiEngine (not just Engine) so the /speakers route's
    `isinstance(coqui, CoquiEngine)` gate is satisfied and the fake's
    `_speakers` attribute is reachable from the route handler."""

    name = "coqui"

    def __init__(self, sleep_sec: float = 0.0, known_speakers: Optional[list[str]] = None) -> None:
        super().__init__()
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
    # Remove the real Kokoro engine before TestClient triggers the startup
    # event — the eager preload (`_preload_default_engines` in main.py) would
    # otherwise flip `kokoro_loaded`/`kokoro_loading` to True and break the
    # "fresh sidecar" invariant the assertions below pin. The Kokoro health
    # path handles a missing engine by returning False/False, which matches
    # what test_health_smoke asserts.
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    with TestClient(main.app) as c:
        # Attach fake so tests can inspect calls.
        c.app_state_fake_engine = fake  # type: ignore[attr-defined]
        yield c


def test_health_smoke(client: TestClient) -> None:
    """/health returns the engines registry + load state. The
    model_loaded/loading/device fields drive the Coqui pill;
    kokoro_loaded/kokoro_loading drive the Kokoro pill. Both must surface
    from the same single response so the consolidated frontend hook stays
    on one /health poll per tick (see useTtsLifecycle invariant)."""
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "coqui" in body["engines"]
    # Fresh engine: nothing loaded yet, not currently loading.
    assert body["model_loaded"] is False
    assert body["loading"] is False
    assert body["device"] is None
    # Kokoro fields must be present (False/False on a fresh sidecar where
    # the eager preload hook hasn't fired — same shape the frontend reads).
    assert body["kokoro_loaded"] is False
    assert body["kokoro_loading"] is False


def test_health_reports_effective_recycle_ceilings(client: TestClient) -> None:
    """/health surfaces the EFFECTIVE hard recycle ceilings (committed RAM and
    reserved VRAM) so the Node spawn-gate can detect a sidecar started under a
    DIFFERENT config (e.g. a dev launch with no .env → auto ceiling) and refuse
    to adopt it. Keys must always be present (value may be None when a ceiling
    is disabled / VRAM is unreadable)."""
    body = client.get("/health").json()
    assert "mem_restart_mb" in body
    assert "vram_restart_mb" in body
    # When set, they are positive numbers; None is allowed (disabled/unreadable).
    for key in ("mem_restart_mb", "vram_restart_mb"):
        val = body[key]
        assert val is None or (isinstance(val, (int, float)) and val > 0)


def test_health_reflects_loaded_state(client: TestClient) -> None:
    """When the model is loaded, /health reports model_loaded:true and the
    resolved device. The Generate-screen pill flips from 'Idle' → 'Model
    ready' based on this; without it, the user has no signal that their
    Load click actually took effect."""
    fake = client.app_state_fake_engine  # type: ignore[attr-defined]
    fake._tts = object()  # sentinel — _FakeEngine.synthesize doesn't read it
    fake._resolved_device = "cuda"

    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["model_loaded"] is True
    assert body["device"] == "cuda"


def test_load_endpoint_idempotent_when_already_loaded(client: TestClient) -> None:
    """POST /load with a model already resident must return {status: ready}
    immediately without re-running _ensure_loaded. The UI's auto-evict flow
    fires /load on every screen entry; if it actually reloaded each time,
    every navigation would burn 30–60s on a real box."""
    fake = client.app_state_fake_engine  # type: ignore[attr-defined]
    sentinel = object()
    fake._tts = sentinel  # pretend already loaded

    r = client.post("/load", json={"model": "xtts_v2"})
    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    # Critical: _tts must still be our sentinel (no re-init happened).
    assert fake._tts is sentinel


def test_unload_endpoint_idempotent_when_idle(client: TestClient) -> None:
    """POST /unload on a fresh sidecar (no model loaded) must succeed with
    {status: idle} — the Analysing screen's Load button always evicts TTS
    first, so this path is hit on every analyzer-Load click whether or not
    the TTS was warm. A 500 here would surface as a phantom error toast."""
    r = client.post("/unload")
    assert r.status_code == 200
    assert r.json() == {"status": "idle"}


def test_unload_endpoint_drops_loaded_model(client: TestClient) -> None:
    """POST /unload with a model resident must call CoquiEngine.unload()
    and report idle. After this round-trip, /health must reflect the new
    state so the UI's pill flips back to 'Idle'."""
    fake = client.app_state_fake_engine  # type: ignore[attr-defined]
    fake._tts = object()
    fake._speakers = ["Claribel Dervla"]

    r = client.post("/unload")
    assert r.status_code == 200
    assert r.json() == {"status": "idle"}
    assert fake._tts is None
    assert fake._speakers == []

    health = client.get("/health").json()
    assert health["model_loaded"] is False


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


class _FakeTorchCuda:
    """Minimal stub of torch.cuda exposing only `is_available()`."""

    def __init__(self, available: bool) -> None:
        self._available = available

    def is_available(self) -> bool:
        return self._available


class _FakeTorch:
    """Minimal stub of the torch module; only `.cuda.is_available()` is read
    by `CoquiEngine._resolve_runtime_options`. Lets the resolver tests exercise
    real env-var → runtime-config logic without loading the ~3 GB XTTS model
    or requiring PyTorch in the test venv."""

    def __init__(self, cuda_available: bool) -> None:
        self.cuda = _FakeTorchCuda(cuda_available)


def test_resolve_runtime_options_cpu_default(monkeypatch):
    """CPU box, no env overrides → device=cpu, half/deepspeed both forced off.
    fp16 ops crash on CPU torch and deepspeed-inference is CUDA-only, so the
    resolver must never let them through on a CPU device, even if the user
    set COQUI_HALF=1 by mistake."""
    monkeypatch.delenv("COQUI_DEVICE", raising=False)
    monkeypatch.delenv("COQUI_HALF", raising=False)
    monkeypatch.delenv("COQUI_DEEPSPEED", raising=False)
    engine = main.CoquiEngine()
    opts = engine._resolve_runtime_options(_FakeTorch(cuda_available=False))
    assert opts == {"device": "cpu", "half": False, "deepspeed": False}


def test_resolve_runtime_options_cuda_defaults_on(monkeypatch):
    """CUDA available, no env overrides → device=cuda, half=True, deepspeed=True.
    The whole point of the GPU install path is that the speedup knobs default
    on; users shouldn't have to know about them to get the win."""
    monkeypatch.delenv("COQUI_DEVICE", raising=False)
    monkeypatch.delenv("COQUI_HALF", raising=False)
    monkeypatch.delenv("COQUI_DEEPSPEED", raising=False)
    engine = main.CoquiEngine()
    opts = engine._resolve_runtime_options(_FakeTorch(cuda_available=True))
    assert opts == {"device": "cuda", "half": True, "deepspeed": True}


def test_resolve_runtime_options_env_overrides_off(monkeypatch):
    """COQUI_HALF=0 / COQUI_DEEPSPEED=0 force the extras off even on CUDA.
    Escape hatch for the rare voice that degrades in fp16 or a deepspeed
    install that misbehaves — flip the env, restart the sidecar, recover."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.setenv("COQUI_HALF", "0")
    monkeypatch.setenv("COQUI_DEEPSPEED", "0")
    engine = main.CoquiEngine()
    opts = engine._resolve_runtime_options(_FakeTorch(cuda_available=True))
    assert opts == {"device": "cuda", "half": False, "deepspeed": False}


def test_resolve_runtime_options_cpu_forced_ignores_extras(monkeypatch):
    """COQUI_DEVICE=cpu pins device=cpu and forces extras off regardless of
    their env values. Prevents a CPU user from triggering a runtime crash by
    leaving COQUI_HALF=1 in their .env after switching machines."""
    monkeypatch.setenv("COQUI_DEVICE", "cpu")
    monkeypatch.setenv("COQUI_HALF", "1")
    monkeypatch.setenv("COQUI_DEEPSPEED", "1")
    engine = main.CoquiEngine()
    opts = engine._resolve_runtime_options(_FakeTorch(cuda_available=True))
    assert opts == {"device": "cpu", "half": False, "deepspeed": False}


def test_parse_bool_accepts_common_truthy_falsy_values():
    """The env-var parser tolerates the obvious variants so a user editing
    .env doesn't trip on case or whitespace."""
    assert main._parse_bool("1", default=False) is True
    assert main._parse_bool("true", default=False) is True
    assert main._parse_bool("YES", default=False) is True
    assert main._parse_bool(" On ", default=False) is True
    assert main._parse_bool("0", default=True) is False
    assert main._parse_bool("false", default=True) is False
    assert main._parse_bool("OFF", default=True) is False
    # Unknown / empty / None → fall back to default.
    assert main._parse_bool(None, default=True) is True
    assert main._parse_bool("", default=False) is False
    assert main._parse_bool("maybe", default=True) is True


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
    # /speakers now reports every registered engine; assert the Coqui slot
    # specifically rather than full-dict equality so adding more engines
    # (Kokoro etc.) doesn't churn this test.
    body = r.json()
    assert body["coqui"] == fake_speakers
