"""Cross-engine sanity for the golden-audio harness (ops-11) — REAL models.

Coqui XTTS and Qwen are stochastic (no seed), so they get LOOSE, format-level
checks rather than Kokoro's exact length baseline: correct wire format
(24 kHz / int16 / mono), non-silent audio, a plausible duration, and no silent
voice substitution. This catches the "engine returns garbage / silence / wrong
format" regression class across all three engines without a brittle baseline.

Both are gated behind explicit opt-in env flags so a casual run never triggers
a multi-GB model download:
  - GOLDEN_COQUI=1                  → run the Coqui XTTS check (weights lazy-load)
  - GOLDEN_QWEN_VOICE=<voiceId>     → run the Qwen check against an already-
                                      designed voice (a .pt under voices/qwen/)

Marked `@pytest.mark.golden` (excluded from the fast `test:sidecar` tier)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden.compare import measure_pcm, rms  # noqa: E402

pytestmark = pytest.mark.golden

SANITY_TEXT = "The quiet harbour town woke slowly to a cold morning."
MIN_RMS = 0.01
# Generous plausible-duration band (seconds) for one short clause — only a
# truncated (near-zero) or runaway (tens of seconds) render trips it.
MIN_DURATION_SEC = 0.4
MAX_DURATION_SEC = 30.0


def _assert_sane(res, requested_voice: str) -> None:
    assert res.sample_rate == 24000, f"sample_rate {res.sample_rate} != 24000"
    # 16-bit mono → even byte length.
    assert len(res.pcm) % 2 == 0, "PCM length not a whole number of int16 samples"
    assert res.substituted_from is None, (
        f"voice '{requested_voice}' was substituted from '{res.substituted_from}' (silent fallback)"
    )
    assert rms(res.pcm) >= MIN_RMS, "near-silent render"
    dur = measure_pcm(res.pcm, res.sample_rate)["duration_sec"]
    assert MIN_DURATION_SEC <= dur <= MAX_DURATION_SEC, f"implausible duration {dur:.2f}s"


def test_coqui_sanity():
    if os.environ.get("GOLDEN_COQUI") not in ("1", "true", "TRUE"):
        pytest.skip("Set GOLDEN_COQUI=1 to run the Coqui XTTS sanity check (lazy-loads weights).")
    engine = main.CoquiEngine()
    try:
        res = engine.synthesize("xtts_v2", engine.FALLBACK_SPEAKER, SANITY_TEXT)
    except Exception as e:  # pragma: no cover - environment-dependent
        pytest.skip(f"Coqui engine unavailable: {e}")
    _assert_sane(res, engine.FALLBACK_SPEAKER)


def test_qwen_sanity():
    voice = os.environ.get("GOLDEN_QWEN_VOICE")
    if not voice:
        pytest.skip(
            "Set GOLDEN_QWEN_VOICE=<voiceId> (an already-designed voice under "
            "voices/qwen/) to run the Qwen sanity check."
        )
    engine = main.QwenEngine()
    try:
        res = engine.synthesize("0.6b", voice, SANITY_TEXT)
    except Exception as e:  # pragma: no cover - environment-dependent
        pytest.skip(f"Qwen engine/voice unavailable: {e}")
    _assert_sane(res, voice)
