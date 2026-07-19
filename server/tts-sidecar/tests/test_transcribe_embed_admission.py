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
from typing import Any, Optional

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
    cuda:1 -> the reservation admits onto cuda:1 and that card is threaded into
    the cold load as a `device` PARAMETER (#1730 gap 2), not pre-mutated onto
    the shared ASR._device. Post-load ASR._device reflects it for /health."""
    _swap_asr(monkeypatch, "cuda")
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(main._placement, "probe", lambda: ROOMY_PROBE)
    seen_device: dict[str, Optional[str]] = {}
    orig_ensure = main.WhisperEngine._ensure_loaded

    def _spy_ensure(self, device=None):
        seen_device["device"] = device
        return orig_ensure(self, device)

    monkeypatch.setattr(main.WhisperEngine, "_ensure_loaded", _spy_ensure)

    r = asr_client.post("/transcribe", content=_pcm(), headers={"X-Sample-Rate": "24000"})

    assert r.status_code == 200
    assert seen_device["device"] == "cuda:1"  # admitted card arrives as a PARAM
    assert main.ASR._device == "cuda:1"        # load reflected it for /health


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
    cuda:1 -> the reservation admits onto cuda:1 and that card is threaded into
    ensure_loaded() as a `device` PARAMETER (#1730 gap 2), applied under its
    load lock rather than pre-mutated onto the shared SPK.device."""
    _install_speechbrain_stub(monkeypatch)
    _stub_torch_cuda(monkeypatch)
    _swap_spk(monkeypatch, "cuda")
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(main._placement, "probe", lambda: ROOMY_PROBE)
    seen_device: dict[str, Optional[str]] = {}
    orig_ensure_loaded = main.SpeakerEngine.ensure_loaded

    async def _spy_ensure_loaded(self, device=None):
        seen_device["device"] = device
        return await orig_ensure_loaded(self, device)

    monkeypatch.setattr(main.SpeakerEngine, "ensure_loaded", _spy_ensure_loaded)
    monkeypatch.setattr(main.SpeakerEngine, "embed", lambda self, pcm, sr: [0.0] * 192)

    r = embed_client.post("/embed", content=_pcm(seconds=0.5, sample_rate=16000), headers={"X-Sample-Rate": "16000"})

    assert r.status_code == 200
    assert seen_device["device"] == "cuda:1"  # admitted card arrives as a PARAM
    assert main.SPK.device == "cuda:1"


# ── device-steer atomicity: the load honours the threaded `device` param, not a
#    stale shared `self._device`/`self.device` (#1730 gap 2) ─────────────────
#
# The route no longer mutates the engine's device attr before an unlocked cold
# load; it threads the admitted card in as a call PARAMETER (mirroring the
# `/load` path). These prove the load derives its card from that param even when
# the shared attr has been left stale by a concurrent op — so a concurrent
# multi-GPU FIRST cold-load can't land on the wrong card.


def test_asr_ensure_loaded_uses_device_param_not_stale_self_device(
    monkeypatch, fake_whisper_module
) -> None:
    """ASR: `_ensure_loaded(device="cuda:1")` must build the CT2 model from the
    cuda:1 PARAM even though `self._device` is a stale cuda:0 (as if a concurrent
    first cold-load clobbered it in the gap). Pre-fix `_ensure_loaded` took no
    device and read `self._device`, landing the load on the wrong card."""
    monkeypatch.setenv("ASR_DEVICE", "cuda:0")
    eng = main.WhisperEngine()
    eng._device = "cuda:0"  # stale shared attr

    seen: dict[str, str] = {}
    orig_ct2 = main._ct2_kwargs

    def _spy_ct2(device: str, compute_type: str) -> dict:
        seen["device"] = device
        return orig_ct2(device, compute_type)

    monkeypatch.setattr(main, "_ct2_kwargs", _spy_ct2)

    eng._ensure_loaded(device="cuda:1")

    assert seen["device"] == "cuda:1"  # load derived from the PARAM, not self._device
    assert eng._device == "cuda:1"     # reflected post-load for /health fell_back


def test_spk_ensure_loaded_uses_device_param_not_stale_self_device(monkeypatch) -> None:
    """SPK: `ensure_loaded(device="cuda:1")` must load ECAPA on the cuda:1 PARAM
    under the load lock even though `self.device` is a stale cuda:0. Pre-fix
    `ensure_loaded` took no device and the route pre-mutated `self.device`
    outside the lock, so a concurrent first cold-load could clobber it."""
    import asyncio

    _install_speechbrain_stub(monkeypatch)
    _stub_torch_cuda(monkeypatch)
    monkeypatch.setenv("SPK_DEVICE", "cuda:0")
    eng = main.SpeakerEngine()
    eng.device = "cuda:0"  # stale shared attr

    captured: dict[str, str] = {}

    def _spy_load_on(self, device: str):
        captured["device"] = device
        return _FakeSpkModel()

    monkeypatch.setattr(main.SpeakerEngine, "_load_on", _spy_load_on)

    asyncio.run(eng.ensure_loaded(device="cuda:1"))

    assert captured["device"] == "cuda:1"  # _load_on got the PARAM's card
    assert eng.device == "cuda:1"
