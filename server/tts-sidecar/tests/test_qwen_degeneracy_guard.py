"""Regression: the Qwen Base synth output-degeneracy guard (silent #1558 variant).

Under 8GB VRAM churn the Qwen Base model can enter a DEGENERATE-LOAD state where
the forward runs WITHOUT error but emits near-empty audio (~zero speech tokens,
immediate EOS) — a broken/near-silent sentence that today ships silently. The
load-time meta-tensor guard (`_load_qwen_model`) can't see it because the load
"succeeds". These pin the OUTPUT-degeneracy guard added to `QwenEngine`:

  (a) a degenerate first synth (near-empty audio for SUBSTANTIAL text) triggers
      exactly ONE in-process Base reload + retry;
  (b) if the retry returns healthy audio, THAT audio is returned and NO recycle
      self-exit fires;
  (c) if the retry is STILL degenerate, the persistent fault escalates down the
      SAME supervised code-44 recycle path the persistent meta fault uses (spied,
      never a real os._exit) and the request fails loud;
  (d) legitimately short text with short audio does NOT trip the guard (the
      false-positive fence).

Pure-logic + GPU-free: the model is a scripted fake (no real torch / weights), and
the reload path is exercised by stubbing `_ensure_*_loaded` to re-install the fake.
Mirrors the injected-fake-torch discipline of test_runtime_wiring.py /
test_qwen_load_reclaim.py.
"""

import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

# Same sys.path bootstrap other sidecar tests rely on (the rootdir conftest puts
# the sidecar root on the path, but be explicit so this file collects standalone).
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# ── pure detection helper ────────────────────────────────────────────────────

def test_degeneracy_helper_flags_near_empty_audio_for_substantial_text() -> None:
    # 18 chars, 160 ms → 8.9 ms/char, below the 20 ms/char floor → degenerate.
    assert main._qwen_synth_is_degenerate("a" * 18, 160.0) is True


def test_degeneracy_helper_ignores_short_text() -> None:
    # Under the min-length gate: a single char / interjection is never flagged,
    # no matter how short its audio.
    assert main._qwen_synth_is_degenerate("Oh!", 10.0) is False
    assert main._qwen_synth_is_degenerate("a" * (main._QWEN_DEGEN_MIN_TEXT_LEN - 1), 1.0) is False


def test_degeneracy_helper_passes_healthy_audio() -> None:
    # 20 chars at ~60 ms/char (healthy speech) → well above the floor.
    assert main._qwen_synth_is_degenerate("a" * 20, 1200.0) is False


def test_degeneracy_helper_ignores_long_punctuation_separator_lines() -> None:
    """A long separator / ellipsis / markup-only line has many RAW chars but ~zero
    SPEAKABLE ones, so it renders legitimately short and must NOT be flagged — the
    denominator is speakable chars, not len(text). This is the false-positive that
    would otherwise force a reload+retry then a code-44 recycle (which bypasses the
    supervisor streak-trip → could loop on a deterministic FP)."""
    assert main._qwen_synth_is_degenerate("—" * 30, 5.0) is False   # em-dash rule
    assert main._qwen_synth_is_degenerate("." * 40, 5.0) is False   # ellipsis run
    assert main._qwen_synth_is_degenerate("* * *  <br/>  * * *", 5.0) is False
    # Whitespace/punctuation don't count toward the speakable floor.
    assert main._qwen_speakable_len("———— <br/> ————") < main._QWEN_DEGEN_MIN_TEXT_LEN


def test_degeneracy_helper_still_flags_real_text_with_incidental_punctuation() -> None:
    """Real speech with ordinary punctuation still has plenty of speakable chars, so
    a genuinely near-empty render for it is STILL flagged (the FP fix must not blind
    the guard to the real fault)."""
    # "The door creaked open, slowly." → 24 speakable letters; 160 ms is degenerate.
    assert main._qwen_synth_is_degenerate("The door creaked open, slowly.", 160.0) is True
    assert main._qwen_speakable_len("The door creaked open, slowly.") >= main._QWEN_DEGEN_MIN_TEXT_LEN


# ── engine-level guard (end-to-end through synthesize) ───────────────────────

class _ScriptedBase:
    """Fake Qwen Base whose `generate_voice_clone` emits audio of a length driven
    by a SHARED script dict, so a test can make the first forward degenerate and a
    post-reload forward healthy. A reload builds a NEW instance, so the per-call
    cursor lives in the shared `state`, not on `self`."""

    def __init__(self, state: dict[str, Any]) -> None:
        self._state = state

    def generate_voice_clone(self, text: Any, language: Any, voice_clone_prompt: Any):
        state = self._state
        i = state["idx"]
        state["idx"] += 1
        seq = state["audio_ms"]
        ms = seq[i] if i < len(seq) else seq[-1]
        sr = state["sr"]
        n = max(int(round(ms / 1000.0 * sr)), 0)
        return [np.zeros(n, dtype=np.float32)], sr


@pytest.fixture
def degen_runtime(monkeypatch):
    """Wire the global Qwen engine with a scripted fake Base + stubbed ensure/
    prompt/reclaim so `synthesize` runs the guard with no torch, model, or GPU.
    Records recycle escalations WITHOUT arming a real self-exit."""
    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)

    # The suite disables the guard by default (conftest sets QWEN_DEGEN_GUARD=0);
    # this file is the one place that exercises it, so turn it ON explicitly.
    monkeypatch.setattr(main, "_QWEN_DEGEN_GUARD_ENABLED", True)

    state: dict[str, Any] = {"idx": 0, "audio_ms": [], "sr": 24000, "loads": 0}
    engine._base = None
    engine._base17 = None
    engine._design = None

    def _fake_ensure_base() -> None:
        # Cold-load only on the None→instance transition (matches the real
        # _ensure_base_loaded fast-path), so `loads` counts real reloads.
        if engine._base is None:
            engine._base = _ScriptedBase(state)
            state["loads"] += 1

    def _fake_ensure_base17() -> None:
        if engine._base17 is None:
            engine._base17 = _ScriptedBase(state)
            state["loads"] += 1

    monkeypatch.setattr(engine, "_ensure_base_loaded", _fake_ensure_base)
    monkeypatch.setattr(engine, "_ensure_base17_loaded", _fake_ensure_base17)
    monkeypatch.setattr(engine, "_load_voice_prompt", lambda voice: (["p"], "English", False))
    monkeypatch.setattr(engine, "_load_voice_prompt_17b", lambda voice: (["p"], "English", False))
    # No real gc/CUDA to reclaim, and skip the emotion-gain voice lookup.
    monkeypatch.setattr(main, "_reclaim_host_and_vram", lambda: None)
    monkeypatch.setattr(main, "_apply_emotion_gain", lambda audio, voice: audio)

    recycles: list[tuple[str, str]] = []
    monkeypatch.setattr(
        main, "_schedule_model_load_fault_restart",
        lambda model_id, detail: recycles.append((model_id, detail)),
    )

    yield {"engine": engine, "state": state, "recycles": recycles}

    engine._base = None
    engine._base17 = None


# A substantial line — 22 chars, well over the 10-char min-length gate.
_SUBSTANTIAL = "The door creaked open."


def test_degenerate_then_healthy_reloads_once_and_returns_healthy(degen_runtime) -> None:
    """(a)+(b): a degenerate first forward triggers exactly one reload+retry; the
    healthy retry audio is returned and NO recycle fires."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    # First forward degenerate (160 ms), retry healthy (1200 ms).
    state["audio_ms"] = [160.0, 1200.0]

    res = engine.synthesize("0.6b", "v", _SUBSTANTIAL)

    assert state["idx"] == 2, "exactly two forwards: the degenerate one + the retry"
    assert state["loads"] == 2, "initial load + exactly ONE in-process reload"
    assert not degen_runtime["recycles"], "a recovered retry must NOT self-recycle"
    # The returned PCM is the HEALTHY retry's audio (1200 ms @ 24 kHz), not the
    # degenerate 160 ms — proof the retry's output is what ships.
    healthy_frames = int(round(1200.0 / 1000.0 * state["sr"]))
    assert len(res.pcm) // 2 == healthy_frames


def test_persistent_degeneracy_escalates_to_supervised_recycle(degen_runtime) -> None:
    """(c): still degenerate after the one reload → escalate down the code-44
    recycle path (spied) and raise so the request fails loud, not near-silent."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    # Both forwards degenerate.
    state["audio_ms"] = [160.0, 160.0]

    with pytest.raises(RuntimeError, match="degenerate"):
        engine.synthesize("0.6b", "v", _SUBSTANTIAL)

    assert state["idx"] == 2, "the degenerate forward + one retry, then escalate"
    assert state["loads"] == 2, "exactly one in-process reload before escalating"
    assert len(degen_runtime["recycles"]) == 1, "persistent degeneracy self-recycles once"
    assert degen_runtime["recycles"][0][0] == engine.BASE_MODEL


def test_legitimately_short_text_does_not_trigger_guard(degen_runtime) -> None:
    """(d): a genuinely short utterance with short audio must pass straight
    through — no reload, no retry, no recycle (the false-positive fence)."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    state["audio_ms"] = [120.0]  # short audio for a short interjection

    res = engine.synthesize("0.6b", "v", "Oh!")

    assert state["idx"] == 1, "one forward only — no retry"
    assert state["loads"] == 1, "no reload"
    assert not degen_runtime["recycles"]
    short_frames = int(round(120.0 / 1000.0 * state["sr"]))
    assert len(res.pcm) // 2 == short_frames


def test_long_separator_line_does_not_trigger_guard_end_to_end(degen_runtime) -> None:
    """(d, extended): a LONG punctuation/separator line (many raw chars, ~zero
    speakable) with near-zero audio must pass straight through — no reload, no
    recycle. This is the FP that would otherwise loop a code-44 recycle."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    state["audio_ms"] = [5.0]  # a rule legitimately renders to almost nothing

    engine.synthesize("0.6b", "v", "———————————————")  # 15 em-dashes, 0 speakable

    assert state["idx"] == 1, "one forward only — no retry on a separator line"
    assert state["loads"] == 1, "no reload"
    assert not degen_runtime["recycles"], "a separator line must NOT self-recycle"


def test_guard_also_covers_the_1_7b_base_path(degen_runtime) -> None:
    """The 1.7B path shares the fault mode, so it routes through the same guard:
    a degenerate first forward reloads+retries once and returns the healthy retry."""
    engine = degen_runtime["engine"]
    state = degen_runtime["state"]
    state["audio_ms"] = [160.0, 1200.0]

    res = engine.synthesize("1.7b", "v", _SUBSTANTIAL)

    assert state["idx"] == 2
    assert state["loads"] == 2, "initial 1.7B load + exactly one reload"
    assert not degen_runtime["recycles"]
    healthy_frames = int(round(1200.0 / 1000.0 * state["sr"]))
    assert len(res.pcm) // 2 == healthy_frames
