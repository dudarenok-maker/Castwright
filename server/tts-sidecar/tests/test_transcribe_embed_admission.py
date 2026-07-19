"""Tests for capacity-admission + device-steer wrapping of `/transcribe` and
`/embed` (task 4, vram-aware-placement plan). ASR/SPK are CPU-default
engines — these tests pin the wrap to fire ONLY when the engine is
GPU-configured (`ASR_DEVICE=cuda` / `SPK_DEVICE=cuda`): the cpu-default path
never touches `_placement`, flag-on or off — parity with today's zero-VRAM
behaviour. The cuda-configured path capacity-admits like
`/qwen/design-voice` (see test_design_mint_admission.py) with one deliberate
difference: ASR/SPK use `cpu_capable=False, heavy=False`, so a no-fit probe
ALWAYS 503s `noCapacity` rather than silently falling back to cpu — honouring
the operator's explicit `ASR_DEVICE=cuda` / `SPK_DEVICE=cuda` opt-in (a
GPU-configured op that can't fit should surface as "evict and retry", not
silently degrade to a device the operator didn't ask for)."""
from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def _pcm(seconds: float = 1.0, sample_rate: int = 24000) -> bytes:
    return np.zeros(int(seconds * sample_rate), dtype="<i2").tobytes()


ROOMY_PROBE = [
    {"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8192, "freeMb": 5000},
    {"kind": "cuda", "index": 1, "label": "g1", "totalMb": 24000, "freeMb": 20000},
]
NO_FIT_PROBE = [{"kind": "cuda", "index": 0, "label": "g0", "totalMb": 8000, "freeMb": 100}]


# ── /transcribe ──────────────────────────────────────────────────────────


class _FakeWhisperModel:
    """Minimal faster-whisper stand-in — just enough for the route to
    complete without the real model weights."""

    def __init__(self, model_name: str, device: str = "cpu", compute_type: str = "int8", **kw: Any) -> None:
        self.device = device

    def transcribe(self, audio: Any, **kw: Any):
        class _Seg:
            text = "hi"
            avg_logprob = -0.1
            no_speech_prob = 0.01
            compression_ratio = 1.0
            words = None

        class _Info:
            language = "en"

        return iter([_Seg()]), _Info()


@pytest.fixture
def fake_whisper_module(monkeypatch):
    fake_mod = types.ModuleType("faster_whisper")
    fake_mod.WhisperModel = _FakeWhisperModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", fake_mod)
    yield


@pytest.fixture
def asr_client(monkeypatch, fake_whisper_module):
    """TestClient with poison/recycle fences cleared so the route reaches the
    admission wrap. Individual tests swap in their own ASR engine via
    `_swap_asr` so each controls `ASR_DEVICE` before construction."""
    monkeypatch.setattr(main, "_process_poisoned", False, raising=False)
    monkeypatch.setattr(main, "_restart_pending", False, raising=False)
    main._reset_poison_for_test()
    with TestClient(main.app) as c:
        yield c
    main._reset_poison_for_test()


def _swap_asr(monkeypatch, device: str) -> "main.WhisperEngine":
    """Construct a fresh WhisperEngine with ASR_DEVICE=device (mirrors how
    the real engine reads its device at __init__ time) and install it as the
    module-level ASR singleton the route calls."""
    monkeypatch.setenv("ASR_DEVICE", device)
    engine = main.WhisperEngine()
    monkeypatch.setattr(main, "ASR", engine)
    return engine


@pytest.mark.parametrize("flag", ["0", "1"])
def test_transcribe_cpu_default_never_probes(monkeypatch, asr_client, flag) -> None:
    """ASR_DEVICE=cpu (default): /transcribe never calls the placement probe
    — flag ON or OFF, the cpu path is unwrapped."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", flag)
    _swap_asr(monkeypatch, "cpu")
    probe_calls: list[int] = []
    monkeypatch.setattr(main._placement, "probe", lambda: probe_calls.append(1) or [])

    r = asr_client.post("/transcribe", content=_pcm(), headers={"X-Sample-Rate": "24000"})

    assert r.status_code == 200
    assert probe_calls == []


def test_transcribe_gpu_no_fit_returns_503(monkeypatch, asr_client) -> None:
    """ASR_DEVICE=cuda + flag ON + a no-fit probe -> 503 noCapacity, needing
    the seeded 400 MB asr footprint, before the (cold) transcribe ever runs."""
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    _swap_asr(monkeypatch, "cuda")
    monkeypatch.setattr(main._placement, "probe", lambda: NO_FIT_PROBE)

    r = asr_client.post("/transcribe", content=_pcm(), headers={"X-Sample-Rate": "24000"})

    assert r.status_code == 503
    body = r.json()
    assert body["noCapacity"] is True
    assert body["neededMb"] == 400


def test_transcribe_gpu_steers_to_roomier_device(monkeypatch, asr_client) -> None:
    """ASR_DEVICE=cuda (unindexed, so unpinned) + flag ON + a probe favouring
    cuda:1 -> the reservation admits onto cuda:1 and ASR._device is steered
    there BEFORE the transcribe call runs."""
    _swap_asr(monkeypatch, "cuda")
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(main._placement, "probe", lambda: ROOMY_PROBE)
    seen_device: dict[str, str] = {}
    orig_transcribe = main.WhisperEngine.transcribe

    def _spy_transcribe(self, *a, **k):
        seen_device["device"] = self._device
        return orig_transcribe(self, *a, **k)

    monkeypatch.setattr(main.WhisperEngine, "transcribe", _spy_transcribe)

    r = asr_client.post("/transcribe", content=_pcm(), headers={"X-Sample-Rate": "24000"})

    assert r.status_code == 200
    assert seen_device["device"] == "cuda:1"
    assert main.ASR._device == "cuda:1"


# ── /embed ───────────────────────────────────────────────────────────────


class _FakeSpkModel:
    """Stand-in for the ECAPA EncoderClassifier — embed() isn't exercised in
    these admission tests, only ensure_loaded()'s device plumbing."""


def _install_speechbrain_stub(monkeypatch: pytest.MonkeyPatch) -> None:
    mod_speechbrain = types.ModuleType("speechbrain")
    mod_inference = types.ModuleType("speechbrain.inference")
    mod_speaker = types.ModuleType("speechbrain.inference.speaker")

    class _EncoderClassifier:
        pass

    _EncoderClassifier.from_hparams = staticmethod(lambda **kw: _FakeSpkModel())
    mod_speaker.EncoderClassifier = _EncoderClassifier
    mod_inference.speaker = mod_speaker
    mod_speechbrain.inference = mod_inference
    monkeypatch.setitem(sys.modules, "speechbrain", mod_speechbrain)
    monkeypatch.setitem(sys.modules, "speechbrain.inference", mod_inference)
    monkeypatch.setitem(sys.modules, "speechbrain.inference.speaker", mod_speaker)


def _stub_torch_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(is_available=lambda: True, empty_cache=lambda: None)
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)


@pytest.fixture
def embed_client(monkeypatch):
    monkeypatch.setattr(main, "_process_poisoned", False, raising=False)
    monkeypatch.setattr(main, "_restart_pending", False, raising=False)
    main._reset_poison_for_test()
    # Bare TestClient (no `with`) — matches test_speaker_embed.py; /embed
    # doesn't need lifespan and this avoids the startup preload hooks.
    yield TestClient(main.app)
    main._reset_poison_for_test()


def _swap_spk(monkeypatch, device: str) -> "main.SpeakerEngine":
    monkeypatch.setenv("SPK_DEVICE", device)
    engine = main.SpeakerEngine()
    monkeypatch.setattr(main, "SPK", engine)
    return engine


@pytest.mark.parametrize("flag", ["0", "1"])
def test_embed_cpu_default_never_probes(monkeypatch, embed_client, flag) -> None:
    """SPK_DEVICE=cpu (default): /embed never calls the placement probe —
    flag ON or OFF, the cpu path is unwrapped."""
    _install_speechbrain_stub(monkeypatch)
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", flag)
    _swap_spk(monkeypatch, "cpu")
    monkeypatch.setattr(main.SPK, "embed", lambda pcm, sr: [0.0] * 192)
    probe_calls: list[int] = []
    monkeypatch.setattr(main._placement, "probe", lambda: probe_calls.append(1) or [])

    r = embed_client.post("/embed", content=_pcm(seconds=0.5, sample_rate=16000), headers={"X-Sample-Rate": "16000"})

    assert r.status_code == 200
    assert probe_calls == []


def test_embed_gpu_no_fit_returns_503(monkeypatch, embed_client) -> None:
    """SPK_DEVICE=cuda + flag ON + a no-fit probe -> 503 noCapacity, needing
    the seeded 200 MB spk footprint, before ensure_loaded()/embed ever run."""
    _install_speechbrain_stub(monkeypatch)
    _stub_torch_cuda(monkeypatch)
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    _swap_spk(monkeypatch, "cuda")
    monkeypatch.setattr(main._placement, "probe", lambda: NO_FIT_PROBE)

    r = embed_client.post("/embed", content=_pcm(seconds=0.5, sample_rate=16000), headers={"X-Sample-Rate": "16000"})

    assert r.status_code == 503
    body = r.json()
    assert body["noCapacity"] is True
    assert body["neededMb"] == 200


def test_embed_gpu_steers_to_roomier_device(monkeypatch, embed_client) -> None:
    """SPK_DEVICE=cuda (unindexed, so unpinned) + flag ON + a probe favouring
    cuda:1 -> the reservation admits onto cuda:1 and SPK.device is steered
    there BEFORE ensure_loaded()/embed run."""
    _install_speechbrain_stub(monkeypatch)
    _stub_torch_cuda(monkeypatch)
    _swap_spk(monkeypatch, "cuda")
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(main._placement, "probe", lambda: ROOMY_PROBE)
    seen_device: dict[str, str] = {}
    orig_ensure_loaded = main.SpeakerEngine.ensure_loaded

    async def _spy_ensure_loaded(self):
        seen_device["device"] = self.device
        return await orig_ensure_loaded(self)

    monkeypatch.setattr(main.SpeakerEngine, "ensure_loaded", _spy_ensure_loaded)
    monkeypatch.setattr(main.SpeakerEngine, "embed", lambda self, pcm, sr: [0.0] * 192)

    r = embed_client.post("/embed", content=_pcm(seconds=0.5, sample_rate=16000), headers={"X-Sample-Rate": "16000"})

    assert r.status_code == 200
    assert seen_device["device"] == "cuda:1"
    assert main.SPK.device == "cuda:1"
