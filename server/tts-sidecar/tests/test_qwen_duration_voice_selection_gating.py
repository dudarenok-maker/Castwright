"""Fast-tier coverage for `pick_designed_voice` (#1994).

`pick_designed_voice` is the pure (no `main` import, no I/O) voice-selection
rule the Qwen duration golden test uses to choose which designed Qwen voice to
drive against — an explicit override (GOLDEN_QWEN_VOICE) always wins, otherwise
the first pre-sorted voice wins, else None. It is NOT marked `golden`: it runs
in the normal fast `test:sidecar` tier, mirroring why `test_golden_compare.py`
covers `compare.py` there — cheap coverage of the gate LOGIC without a model,
GPU, or weights.

Mutation-verify procedure (done transiently, reverted before commit): break the
"override always wins" rule by making a non-empty `voices` list beat `override`,
then re-run this file and confirm the first two cases go RED (override no longer
wins). Restore before committing. The observed red output is reported in the
completion comment.
"""
from __future__ import annotations

import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import pytest  # noqa: E402

from tests.golden.prereq import pick_designed_voice  # noqa: E402

VOICES = ["nora", "abe", "zim"]


def test_override_wins_over_first_sorted_voice():
    """An explicit override always wins, even over a non-empty pre-sorted
    voices list (this is the precedence the golden gate relies on when an
    operator explicitly names GOLDEN_QWEN_VOICE)."""
    assert pick_designed_voice(VOICES, "explicit-id") == "explicit-id"


def test_override_wins_over_empty_voices():
    """An override must win even when no designed voice exists on the box —
    this is how a caller with an explicit opt-in fires the golden run where
    discovery alone would skip."""
    assert pick_designed_voice([], "explicit-id") == "explicit-id"


def test_first_sorted_voice_used_without_override():
    """No override + a non-empty pre-sorted list -> voices[0] (the gate fires
    with NO opt-in env var required on a box with a designed voice)."""
    assert pick_designed_voice(VOICES, None) == "nora"


def test_none_when_neither_available():
    """No override and nothing discovered -> None, so the caller can skip
    cleanly rather than inventing a voice."""
    assert pick_designed_voice([], None) is None