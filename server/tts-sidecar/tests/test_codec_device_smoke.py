"""side-25 acceptance smoke: codec-on-GPU correctness for the 0.6B-Base and
VoiceDesign paths (see docs/superpowers/specs/2026-07-06-side25-qwen-codec-
gpu-design.md). tests/golden/test_instruct_golden.py already covers the
1.7B-Base 12Hz decode path at golden tolerances; it does NOT touch these
other two load call-sites at all. This file is a SMOKE check, not a
quality-parity claim: it asserts the codec decodes on both cpu and
QWEN_CODEC_DEVICE=auto without erroring and produces output of the same
length/sample-rate -- not that the two outputs sound identical.

Needs real Qwen weights + CUDA; SKIPs cleanly otherwise (same gate shape as
tests/test_instruct_synth.py's requires_qwen_gpu / conftest._qwen_weights_present).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def _qwen_gpu_available() -> bool:
    """True when qwen_tts + torch + CUDA are all present. Mirrors
    conftest._qwen_weights_present() / test_instruct_synth.py's local copy."""
    try:
        import qwen_tts  # noqa: F401
        import torch  # noqa: F401
        return torch.cuda.is_available()
    except Exception:
        return False


requires_qwen_gpu = pytest.mark.skipif(
    not _qwen_gpu_available(),
    reason="Qwen weights / CUDA not available on this box (side-25 codec smoke skipped)",
)


def _round_trip(model, synthetic_audio):
    """Encode a short synthetic sine wave through the model's own codec and
    decode it straight back -- exercises exactly the encode/decode path the
    placement fix touches, without needing a designed voice or the full
    synthesize() pipeline."""
    tokenizer = main._resolve_speech_tokenizer(model)
    encoded = tokenizer.encode(synthetic_audio, sr=24000)
    return tokenizer.decode(encoded)


@requires_qwen_gpu
@pytest.mark.parametrize("model_attr", ["BASE_MODEL", "VOICEDESIGN_MODEL"])
def test_codec_decode_matches_length_cpu_vs_auto(model_attr: str, monkeypatch) -> None:
    """0.6B-Base and VoiceDesign codec placement smoke check: decoding the
    same short probe through QWEN_CODEC_DEVICE=cpu vs =auto must produce
    the same output length and sample rate."""
    import numpy as np

    synthetic_audio = np.sin(
        np.linspace(0, 440 * 2 * np.pi, 24000)
    ).astype(np.float32)  # 1s @ 24kHz, 440Hz tone

    monkeypatch.setenv("QWEN_CODEC_DEVICE", "cpu")
    engine_cpu = main.QwenEngine()
    engine_cpu._ensure_device_resolved()
    model_id = getattr(engine_cpu, model_attr)
    model_cpu = engine_cpu._load_qwen_model(model_id)
    wavs_cpu, sr_cpu = _round_trip(model_cpu, synthetic_audio)

    monkeypatch.setenv("QWEN_CODEC_DEVICE", "auto")
    engine_gpu = main.QwenEngine()
    engine_gpu._ensure_device_resolved()
    model_gpu = engine_gpu._load_qwen_model(model_id)
    wavs_gpu, sr_gpu = _round_trip(model_gpu, synthetic_audio)

    assert sr_cpu == sr_gpu
    assert len(wavs_cpu[0]) == len(wavs_gpu[0])
    assert len(wavs_cpu[0]) > 0
