"""fs-41/fs-50 (seam 5) — the Qwen voice-design ref_text/calibration line is
language-aware. A hardcoded English ref_text baked into every non-English voice
("the quick brown fox jumps over the lazy dog" on a Spanish voice) was the gap
the Spanish canary surfaced: the clone prompt fixed the timbre on English
phonemes. These tests pin `QwenEngine._calibration_text` — a per-language pangram
for the mapped languages, the English CALIBRATION_TEXT for English/unknown, and
the English path byte-unchanged."""

from __future__ import annotations

import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def _engine() -> "main.QwenEngine":
    # __init__ sets up locks/state only (no model load) — cheap to construct.
    return main.QwenEngine()


def test_spanish_calibration_is_spanish_not_the_english_pangram() -> None:
    text = _engine()._calibration_text("Spanish")
    assert "murciélago" in text  # the Spanish pangram phoneme set
    assert "quick brown fox" not in text  # NOT the English line


def test_each_mapped_language_returns_its_own_line() -> None:
    eng = _engine()
    assert "Portez ce vieux whisky" in eng._calibration_text("French")
    assert "Boxkämpfer" in eng._calibration_text("German")
    assert "французских булок" in eng._calibration_text("Russian")


def test_english_and_unknown_fall_back_to_the_default_calibration_text() -> None:
    eng = _engine()
    default = main.QwenEngine.CALIBRATION_TEXT
    assert eng._calibration_text("English") == default
    assert eng._calibration_text("Klingon") == default  # unmapped → English
    assert eng._calibration_text(None) == default
    assert eng._calibration_text("") == default
    # English default is still the quick-brown-fox line (byte-unchanged).
    assert "quick brown fox" in default
