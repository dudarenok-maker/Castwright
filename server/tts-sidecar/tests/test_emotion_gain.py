"""Per-emotion output gain (fs-55): whisper variants render quieter, angry
louder, keyed on the variant voice's `__<emotion>` suffix so it applies in
NORMAL chapter generation (single + batch), not just auditions."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def test_base_voice_and_non_emotion_suffix_are_unity():
    assert main._emotion_output_gain("qwen-narrator") == 1.0
    # `__1.7b` is the internal Quality-tier cache key, not an emotion → unity.
    assert main._emotion_output_gain("qwen-narrator__1.7b") == 1.0
    assert main._emotion_output_gain("") == 1.0


def test_whisper_quieter_angry_louder_others_unity():
    assert main._emotion_output_gain("qwen-narrator__whisper") == 0.45
    assert main._emotion_output_gain("qwen-x__angry") == 1.5
    assert main._emotion_output_gain("qwen-x__excited") == 1.0
    assert main._emotion_output_gain("qwen-x__sad") == 1.0


def test_env_override(monkeypatch):
    monkeypatch.setenv("QWEN_GAIN_WHISPER", "0.6")
    assert main._emotion_output_gain("c__whisper") == 0.6
    # A bogus value falls back to the default, never raises.
    monkeypatch.setenv("QWEN_GAIN_ANGRY", "not-a-number")
    assert main._emotion_output_gain("c__angry") == 1.5


def test_apply_gain_scales_and_noops():
    a = np.array([0.5, -0.5, 0.25], dtype=np.float32)
    out = main._apply_emotion_gain(a, "c__whisper")  # 0.45
    assert np.allclose(out, a * 0.45)
    # Unity → returns the input untouched (same object, no copy).
    assert main._apply_emotion_gain(a, "c") is a
    assert main._apply_emotion_gain(a, None) is a
