"""WhisperEngine / `/transcribe` coverage — the ASR content-QA gate (srv-31).

The real `faster_whisper` package isn't installed in CI / the dev venv. These
tests stub it via sys.modules so the load + transcribe path executes without the
model weights, then assert on the engine's behaviour and the HTTP surface.

Pins the load-bearing srv-31 invariants:
  - decode is DETERMINISTIC + hallucination-resistant (greedy, temperature 0,
    no cross-sentence carryover, VAD filter) so a QA verdict is idempotent,
  - the intrinsic signals (avg_logprob / no_speech_prob / compression_ratio)
    are surfaced worst-case so the server can tell "audio wrong" from
    "transcript untrustworthy",
  - 24 kHz int16 synth PCM is resampled to the 16 kHz mono float32 Whisper
    wants,
  - the model is CPU-first (ASR_DEVICE default cpu, zero VRAM) and idle-evicts,
  - /transcribe honours the poison + recycle-drain fences like /synthesize.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# ── faster-whisper stub ──────────────────────────────────────────────────


class _FakeSegment:
    """Stand-in for a faster-whisper segment — just the attrs WhisperEngine
    reads."""

    def __init__(
        self,
        text: str,
        avg_logprob: float = -0.2,
        no_speech_prob: float = 0.01,
        compression_ratio: float = 1.3,
    ) -> None:
        self.text = text
        self.avg_logprob = avg_logprob
        self.no_speech_prob = no_speech_prob
        self.compression_ratio = compression_ratio


class _FakeInfo:
    def __init__(self, language: str = "en") -> None:
        self.language = language
        self.language_probability = 0.99
        self.duration = 1.0


class _FakeWhisperModel:
    """Records constructor args + transcribe kwargs so tests can assert on the
    deterministic-decode contract, and returns a configurable transcript +
    signals. Class-level knobs let a test shape the output without
    monkeypatching instances."""

    next_segments: list[_FakeSegment] = [_FakeSegment(" Hello world.")]
    next_language: str = "en"
    instances: list["_FakeWhisperModel"] = []

    def __init__(self, model_name: str, device: str = "cpu", compute_type: str = "int8", **kw: Any) -> None:
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.kwargs = kw
        self.transcribe_calls: list[dict[str, Any]] = []
        _FakeWhisperModel.instances.append(self)

    def transcribe(self, audio: Any, **kw: Any):
        self.transcribe_calls.append({"n_samples": int(getattr(audio, "size", len(audio))), **kw})
        return iter(list(_FakeWhisperModel.next_segments)), _FakeInfo(_FakeWhisperModel.next_language)


@pytest.fixture
def fake_whisper_module(monkeypatch):
    """Insert a fake `faster_whisper` module so WhisperEngine._ensure_loaded's
    `from faster_whisper import WhisperModel` works without the real package.
    Resets the class knobs + instance log between tests."""
    _FakeWhisperModel.next_segments = [_FakeSegment(" Hello world.")]
    _FakeWhisperModel.next_language = "en"
    _FakeWhisperModel.instances = []
    fake_mod = types.ModuleType("faster_whisper")
    fake_mod.WhisperModel = _FakeWhisperModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_mod)
    yield _FakeWhisperModel


def _pcm(seconds: float = 1.0, sample_rate: int = 24000) -> bytes:
    """`seconds` of silent int16 LE mono PCM — enough to exercise resample +
    the byte/sample math without real audio."""
    return np.zeros(int(seconds * sample_rate), dtype="<i2").tobytes()


# ── load wiring ──────────────────────────────────────────────────────────


def test_load_defaults_to_cpu_and_base(fake_whisper_module, monkeypatch) -> None:
    """ASR_DEVICE / ASR_MODEL default to cpu / base — the zero-VRAM, fits-
    anywhere config. A fresh engine reads them at construction."""
    monkeypatch.delenv("ASR_DEVICE", raising=False)
    monkeypatch.delenv("ASR_MODEL", raising=False)
    engine = main.WhisperEngine()
    engine._ensure_loaded()
    model = fake_whisper_module.instances[-1]
    assert model.device == "cpu"
    assert model.model_name == "base"
    assert model.compute_type == "int8"


def test_load_cuda_uses_int8_float16(fake_whisper_module, monkeypatch) -> None:
    """ASR_DEVICE=cuda flips the default compute type to int8_float16 (small
    VRAM, fast) — the opt-in GPU path."""
    monkeypatch.setenv("ASR_DEVICE", "cuda")
    monkeypatch.delenv("ASR_COMPUTE_TYPE", raising=False)
    engine = main.WhisperEngine()
    engine._ensure_loaded()
    model = fake_whisper_module.instances[-1]
    assert model.device == "cuda"
    assert model.compute_type == "int8_float16"


def test_load_is_idempotent(fake_whisper_module) -> None:
    engine = main.WhisperEngine()
    engine._ensure_loaded()
    first = engine._model
    engine._ensure_loaded()
    assert engine._model is first


def test_load_fails_loudly_when_faster_whisper_missing(monkeypatch) -> None:
    """Missing package → a RuntimeError carrying the pip hint, not a bare
    ImportError. Mirrors the Kokoro/Coqui install-hint contract."""
    sys.modules.pop("faster_whisper", None)

    class _Block:
        def find_spec(self, name, *_a, **_k):
            if name == "faster_whisper":
                raise ImportError("simulated missing faster-whisper")
            return None

    finder = _Block()
    sys.meta_path.insert(0, finder)
    try:
        engine = main.WhisperEngine()
        with pytest.raises(RuntimeError) as excinfo:
            engine._ensure_loaded()
        assert "faster-whisper" in str(excinfo.value)
        assert "pip install" in str(excinfo.value)
    finally:
        sys.meta_path.remove(finder)
        sys.modules.pop("faster_whisper", None)


# ── transcribe ───────────────────────────────────────────────────────────


def test_transcribe_uses_deterministic_decode_params(fake_whisper_module) -> None:
    """The idempotency-critical contract: greedy (beam_size=1), temperature 0,
    condition_on_previous_text False, vad_filter True. Without these the same
    audio could pass one run and fail the next — fatal for a QA gate."""
    engine = main.WhisperEngine()
    engine.transcribe(_pcm(), 24000)
    call = fake_whisper_module.instances[-1].transcribe_calls[-1]
    assert call["beam_size"] == 1
    assert call["temperature"] == 0.0
    assert call["condition_on_previous_text"] is False
    assert call["vad_filter"] is True


def test_transcribe_returns_text_and_intrinsic_signals(fake_whisper_module) -> None:
    fake_whisper_module.next_segments = [
        _FakeSegment(" Hello", avg_logprob=-0.3, no_speech_prob=0.02, compression_ratio=1.1),
        _FakeSegment(" world.", avg_logprob=-0.5, no_speech_prob=0.10, compression_ratio=2.0),
    ]
    engine = main.WhisperEngine()
    out = engine.transcribe(_pcm(), 24000)
    assert out["text"] == "Hello world."
    assert out["language"] == "en"
    # Worst-case aggregation: min logprob, max no-speech, max compression.
    assert out["avg_logprob"] == -0.5
    assert out["no_speech_prob"] == 0.10
    assert out["compression_ratio"] == 2.0


def test_transcribe_resamples_to_16k(fake_whisper_module) -> None:
    """24 kHz × 1 s = 24000 samples must arrive at the model as 16000 (16 kHz)
    — faster-whisper's required rate."""
    engine = main.WhisperEngine()
    engine.transcribe(_pcm(seconds=1.0, sample_rate=24000), 24000)
    call = fake_whisper_module.instances[-1].transcribe_calls[-1]
    assert call["n_samples"] == 16000


def test_transcribe_passes_language_hint(fake_whisper_module) -> None:
    engine = main.WhisperEngine()
    engine.transcribe(_pcm(), 24000, language="ru")
    call = fake_whisper_module.instances[-1].transcribe_calls[-1]
    assert call["language"] == "ru"


# ── unload + idle-evict ──────────────────────────────────────────────────


def test_unload_drops_model_and_is_idempotent(fake_whisper_module) -> None:
    engine = main.WhisperEngine()
    engine._ensure_loaded()
    assert engine._model is not None
    assert engine.unload() is True
    assert engine._model is None
    assert engine.unload() is False  # already unloaded


def test_maybe_free_idle_respects_ttl(fake_whisper_module, monkeypatch) -> None:
    """maybe_free_idle frees only once idle past the TTL; a recent transcribe
    keeps it warm (the warm-across-a-chapter reuse the per-sentence pass wants)."""
    clock = {"t": 1000.0}
    monkeypatch.setattr(main.time, "monotonic", lambda: clock["t"])
    engine = main.WhisperEngine()
    engine.transcribe(_pcm(), 24000)  # stamps _last_used = 1000
    # Still warm → not freed.
    clock["t"] = 1000.0 + 60.0
    assert engine.maybe_free_idle(120.0) is False
    assert engine._model is not None
    # Past the TTL → freed.
    clock["t"] = 1000.0 + 121.0
    assert engine.maybe_free_idle(120.0) is True
    assert engine._model is None


# ── HTTP /transcribe ─────────────────────────────────────────────────────


@pytest.fixture
def asr_client(monkeypatch, fake_whisper_module):
    """TestClient with a fresh, swapped-in ASR singleton so the route exercises
    the real engine against the faster-whisper stub."""
    engine = main.WhisperEngine()
    monkeypatch.setattr(main, "ASR", engine)
    with TestClient(main.app) as c:
        yield c, engine


def test_transcribe_route_returns_text_and_signals(asr_client) -> None:
    client, _engine = asr_client
    r = client.post(
        "/transcribe",
        content=_pcm(),
        headers={"X-Sample-Rate": "24000", "Content-Type": "audio/L16"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "Hello world."
    assert "avg_logprob" in body and "no_speech_prob" in body and "compression_ratio" in body


def test_transcribe_route_requires_sample_rate(asr_client) -> None:
    client, _engine = asr_client
    r = client.post("/transcribe", content=_pcm())
    assert r.status_code == 400
    assert "X-Sample-Rate" in r.json()["detail"]


def test_transcribe_route_rejects_empty_body(asr_client) -> None:
    client, _engine = asr_client
    r = client.post("/transcribe", content=b"", headers={"X-Sample-Rate": "24000"})
    assert r.status_code == 400


def test_transcribe_route_fast_fails_while_recycling(asr_client, monkeypatch) -> None:
    """While a recycle is draining (_restart_pending), /transcribe fast-fails a
    non-poisoned 503 just like /synthesize — no new GPU work enters the dying
    process."""
    client, _engine = asr_client
    monkeypatch.setattr(main, "_restart_pending", True)
    r = client.post("/transcribe", content=_pcm(), headers={"X-Sample-Rate": "24000"})
    assert r.status_code == 503
    assert r.json().get("poisoned") is not True


# ── /health surfaces ASR state ───────────────────────────────────────────


def test_health_reports_asr_state(asr_client) -> None:
    client, engine = asr_client
    body = client.get("/health").json()
    assert body["asr_loaded"] is False
    assert body["asr_device"] == engine._device
    # Load via a transcribe, then it flips true.
    client.post("/transcribe", content=_pcm(), headers={"X-Sample-Rate": "24000"})
    assert client.get("/health").json()["asr_loaded"] is True
