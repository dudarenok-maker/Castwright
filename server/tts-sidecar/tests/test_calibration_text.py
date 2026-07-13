"""fs-59 (W4a) — Qwen CJK calibration ref-text. `_calibration_text()` falls
back silently to the English pangram for any unmapped language (see
test_calibration_i18n.py); for a CJK designed voice that means the design
reference clip + clone prompt would fix the timbre on the WRONG phoneme set.
These tests pin `QwenEngine._calibration_text('Chinese' | 'Japanese')` to a
CJK reference line (Han for Chinese, Kana-rich for Japanese), not the English
CALIBRATION_TEXT fallback. Keys are the sidecar language WORD — the same
strings `sidecarLanguageName` returns (server/src/tts/language-registry.ts:
`sidecarName: 'Chinese'` / `'Japanese'`), matching the existing
Spanish/French/German/Russian rows' convention."""

from __future__ import annotations

import re
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

# Han ideographs (CJK Unified Ideographs block).
_HAN_RE = re.compile(r"[一-鿿]")
# Hiragana + Katakana.
_KANA_RE = re.compile(r"[぀-ヿ]")


def _engine() -> "main.QwenEngine":
    # __init__ sets up locks/state only (no model load) — cheap to construct.
    return main.QwenEngine()


def test_chinese_calibration_is_han_not_the_english_pangram() -> None:
    text = _engine()._calibration_text("Chinese")
    assert _HAN_RE.search(text), f"expected Han characters in: {text!r}"
    assert "quick brown fox" not in text


def test_japanese_calibration_is_kana_rich_not_the_english_pangram() -> None:
    text = _engine()._calibration_text("Japanese")
    assert _KANA_RE.search(text), f"expected Kana characters in: {text!r}"
    assert "quick brown fox" not in text


def test_chinese_and_japanese_keys_match_the_sidecar_language_word() -> None:
    # Same convention as the Spanish/French/German/Russian rows: the dict key
    # is exactly the sidecar language WORD (sidecarLanguageName's return
    # value), not the BCP-47 code ('zh'/'ja') and not an English gloss.
    assert "Chinese" in main.QwenEngine.CALIBRATION_TEXTS
    assert "Japanese" in main.QwenEngine.CALIBRATION_TEXTS
