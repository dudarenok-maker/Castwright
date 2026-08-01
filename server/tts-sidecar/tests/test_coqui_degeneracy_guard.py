"""Regression: the Coqui XTTS output-degeneracy guard (#2026 defect 3).

fs-38 Wave 3 on-box acceptance (issue #2026) found XTTS v2 rarely collapses a
short Russian utterance entirely — `Хорошее олово.` -> Whisper auto-detected
FINNISH, `Тёплое море.` -> ENGLISH — and separately draws hallucinated
trailing artifacts on other short lines. `tts.qwen.degenGuard` already existed
for Qwen's own (different) failure mode; there was no Coqui equivalent. These
pin the new `_coqui_synth_is_degenerate` detection helper and the
`CoquiEngine._synthesize_degen_guarded` wrapper around `_synthesize_claimed`:

  (a) a degenerate first synth (implausibly short audio for SUBSTANTIAL text)
      retries ONCE with a fresh stochastic draw — no model reload, since
      nothing about the resident model is broken (unlike Qwen's persistent
      VRAM-churn meta-tensor fault);
  (b) if the retry returns healthy audio, THAT audio is returned;
  (c) if the retry is STILL degenerate, the request fails loud (no
      self-recycle — see the guard's own module-level docstring in main.py
      for why that would not help here);
  (d) legitimately short text, and a long punctuation/separator-only line,
      do NOT trip the guard (the same false-positive fence Qwen's guard
      uses, reused verbatim via `_QWEN_DEGEN_MIN_TEXT_LEN`);
  (e) the suite-wide default (`COQUI_DEGEN_GUARD=0`, set in conftest.py,
      mirroring `QWEN_DEGEN_GUARD=0`) really is off, so every OTHER Coqui
      test's fake short audio can't spuriously retry or raise.

Pure-logic + GPU-free: `self._tts` is a scripted fake (no real TTS/torch), so
this collects and runs without the sidecar venv. Mirrors the injected-fake
discipline of test_qwen_degeneracy_guard.py.
"""

import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# ── pure detection helper ────────────────────────────────────────────────────

def test_degeneracy_helper_flags_near_empty_audio_for_substantial_text() -> None:
    # 18 chars, 160 ms -> 8.9 ms/char, below the 20 ms/char floor -> degenerate.
    assert main._coqui_synth_is_degenerate("a" * 18, 160.0) is True


def test_degeneracy_helper_ignores_short_text() -> None:
    assert main._coqui_synth_is_degenerate("Oh!", 10.0) is False
    assert main._coqui_synth_is_degenerate("a" * (main._COQUI_DEGEN_MIN_TEXT_LEN - 1), 1.0) is False


def test_degeneracy_helper_passes_healthy_audio() -> None:
    # 20 chars at ~60 ms/char (healthy speech) -> well above the floor.
    assert main._coqui_synth_is_degenerate("a" * 20, 1200.0) is False


def test_degeneracy_helper_ignores_long_punctuation_separator_lines() -> None:
    """Same false-positive fence as the Qwen guard: a long separator/ellipsis/
    markup-only line has many RAW chars but ~zero SPEAKABLE ones, so it
    legitimately renders short and must not be flagged."""
    assert main._coqui_synth_is_degenerate("—" * 30, 5.0) is False
    assert main._coqui_synth_is_degenerate("." * 40, 5.0) is False
    assert main._coqui_speakable_len("———— <br/> ————") < main._COQUI_DEGEN_MIN_TEXT_LEN


def test_degeneracy_helper_still_flags_real_text_with_incidental_punctuation() -> None:
    # "The door creaked open, slowly." -> 24 speakable letters; 160 ms is degenerate.
    assert main._coqui_synth_is_degenerate("The door creaked open, slowly.", 160.0) is True


def test_degeneracy_helper_reuses_the_qwen_guards_constants_exactly() -> None:
    """The brief calls for the SAME detection idea, not a re-derived one —
    pin that the Coqui constants are literally the Qwen ones, not a
    coincidentally-equal separate copy that could silently drift."""
    assert main._COQUI_DEGEN_MIN_TEXT_LEN == main._QWEN_DEGEN_MIN_TEXT_LEN
    assert main._COQUI_DEGEN_MS_PER_CHAR == main._QWEN_DEGEN_MS_PER_CHAR


# ── engine-level guard (end-to-end through synthesize) ───────────────────────

class _ScriptedSynthesizer:
    def __init__(self, sample_rate: int) -> None:
        self.output_sample_rate = sample_rate


class _ScriptedTts:
    """Fake `self._tts` whose `.tts()` emits audio of a length driven by a
    SHARED script dict, so a test can make the first forward degenerate and a
    retry healthy. Mirrors `_ScriptedBase` in test_qwen_degeneracy_guard.py,
    adapted to CoquiEngine's `tts.tts(text=, speaker=, language=)` shape."""

    def __init__(self, state: dict[str, Any]) -> None:
        self._state = state
        self.synthesizer = _ScriptedSynthesizer(state["sr"])

    def tts(self, text: str, speaker: str, language: str) -> np.ndarray:
        state = self._state
        i = state["idx"]
        state["idx"] += 1
        seq = state["audio_ms"]
        ms = seq[i] if i < len(seq) else seq[-1]
        n = max(int(round(ms / 1000.0 * state["sr"])), 0)
        return np.zeros(n, dtype=np.float32)


@pytest.fixture
def degen_runtime(monkeypatch):
    """A CoquiEngine wired with a scripted fake `_tts` + a no-op `_ensure_loaded`,
    so `synthesize` runs the guard with no real TTS/torch/GPU. The suite
    disables the guard by default (conftest sets COQUI_DEGEN_GUARD=0); this
    file is the one place that exercises it, so turn it ON explicitly."""
    monkeypatch.setattr(main, "_COQUI_DEGEN_GUARD_ENABLED", True)

    engine = main.CoquiEngine()
    state: dict[str, Any] = {"idx": 0, "audio_ms": [], "sr": 24000}
    engine._tts = _ScriptedTts(state)
    engine._speakers = ["v"]
    engine._use_half = False
    engine._torch = None
    monkeypatch.setattr(engine, "_ensure_loaded", lambda model: None)

    yield {"engine": engine, "state": state}


# A substantial line — 18 speakable chars, well over the 10-char min-length gate.
_SUBSTANTIAL = "The door creaked open."


def test_degenerate_then_healthy_retries_once_and_returns_healthy(degen_runtime) -> None:
    """(a)+(b): a degenerate first forward retries once with a fresh
    stochastic draw; the healthy retry's audio is returned."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    state["audio_ms"] = [160.0, 1200.0]

    res = engine.synthesize("xtts_v2", "v", _SUBSTANTIAL)

    assert state["idx"] == 2, "exactly two forwards: the degenerate one + the retry"
    healthy_frames = int(round(1200.0 / 1000.0 * state["sr"]))
    assert len(res.pcm) // 2 == healthy_frames


def test_persistent_degeneracy_raises_without_a_recycle(degen_runtime) -> None:
    """(c): still degenerate after the one retry -> fail loud. No recycle to
    spy on here (unlike Qwen) — a stochastic-decode fluke isn't a corrupted
    resident model, so there is nothing a self-recycle would fix."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    state["audio_ms"] = [160.0, 160.0]

    with pytest.raises(RuntimeError, match="degenerate"):
        engine.synthesize("xtts_v2", "v", _SUBSTANTIAL)

    assert state["idx"] == 2, "the degenerate forward + one retry, then raise"


def test_legitimately_short_text_does_not_trigger_guard(degen_runtime) -> None:
    """(d): a genuinely short utterance with short audio passes straight
    through — no retry."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    state["audio_ms"] = [120.0]

    res = engine.synthesize("xtts_v2", "v", "Oh!")

    assert state["idx"] == 1, "one forward only — no retry"
    short_frames = int(round(120.0 / 1000.0 * state["sr"]))
    assert len(res.pcm) // 2 == short_frames


def test_long_separator_line_does_not_trigger_guard_end_to_end(degen_runtime) -> None:
    """(d, extended): a LONG punctuation/separator line (many raw chars,
    ~zero speakable) with near-zero audio passes straight through."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    state["audio_ms"] = [5.0]

    engine.synthesize("xtts_v2", "v", "———————————————")  # 15 em-dashes, 0 speakable

    assert state["idx"] == 1, "one forward only — no retry on a separator line"


def test_guard_disabled_by_default_in_suite_ships_degenerate_audio_unretried(monkeypatch) -> None:
    """(e): conftest.py's suite-wide `COQUI_DEGEN_GUARD=0` really is the
    module default here — confirms every OTHER Coqui test's fake short audio
    can't spuriously retry/raise just because this guard now exists."""
    assert main._COQUI_DEGEN_GUARD_ENABLED is False

    engine = main.CoquiEngine()
    state: dict[str, Any] = {"idx": 0, "audio_ms": [1.0], "sr": 24000}
    engine._tts = _ScriptedTts(state)
    engine._speakers = ["v"]
    engine._use_half = False
    engine._torch = None
    monkeypatch.setattr(engine, "_ensure_loaded", lambda model: None)

    engine.synthesize("xtts_v2", "v", _SUBSTANTIAL)

    assert state["idx"] == 1, "guard disabled: single call, no retry despite near-zero audio"
