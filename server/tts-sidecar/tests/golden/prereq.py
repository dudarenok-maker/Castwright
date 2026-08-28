"""Prerequisite classification for the opt-in golden-audio tier (GATE 1 IMP-2).

The golden checks run against REAL models, so a box that simply doesn't have
an engine installed must SKIP rather than fail. The trap is making that skip
too wide: `test_xtts_clone_sanity` wrapped BOTH of its synth calls in

    except Exception as e:
        pytest.skip(f"Coqui engine/voice unavailable: {e}")

and `AssertionError` is an `Exception`. That check exists specifically to
catch the upstream `assert text_tokens.shape[-1] < gpt_max_text_tokens`
crash that fires when `enable_text_splitting=True` is dropped from
`_infer_from_latents` — so the one gate written to catch that regression
reported SKIP, i.e. green, if it ever happened. Same shape swallowed a
`VoiceNotDesignedError` from a broken latents load, a CUDA error, and any
`_infer_from_latents` signature drift.

The rule here: SKIP only when the ENGINE ITSELF is absent from this box.
Everything else — including "the voice you named isn't there", which is a
setup error a caller who explicitly set `GOLDEN_XTTS_CLONE=<uuid>` needs to
SEE — fails the test.

Deliberately import-light (stdlib + pytest, no torch/TTS), so the classifier
has paired coverage in the fast `test:sidecar` tier even though the golden
tests it serves are opt-in and never run there — the same reasoning
`compare.py` documents for the comparison helpers.
"""
from __future__ import annotations

from typing import Any, Optional

import pytest

# Substrings of the RuntimeError `CoquiEngine._ensure_loaded` raises when the
# engine's Python packages are missing from this venv (main.py — "Failed to
# import coqui-tts (...)" / "PyTorch missing from this venv (...)"), plus the
# stdlib phrasing of a bare missing module. Matched case-insensitively on the
# message because `_ensure_loaded` re-wraps the original ImportError in a
# plain RuntimeError, so the exception TYPE alone can't distinguish
# "coqui-tts isn't installed" from "the render failed".
#
# Kokoro has no dedicated marker of its own — it relies solely on the
# generic "no module named" entry, which matches ONLY the specific case
# where the `kokoro_onnx` package itself is absent from this venv (the
# underlying ImportError reads "No module named 'kokoro_onnx'"). A box
# where the package IS installed but a downstream native dependency is
# broken (observed: a corrupt onnxruntime provider raising "Failed to
# import kokoro-onnx (DLL load failed while importing
# onnxruntime_pybind11_state...)") matches no marker here and so FAILS
# rather than skips. That is deliberate, not a gap: #1987's whole point is
# that a broken install must read as a real failure, not a green SKIP, so
# `_make_kokoro` propagating it (via `synthesise_or_skip`, same as here) is
# the intended behaviour for the opt-in golden tier -- this comment
# previously implied blanket Kokoro coverage, which overstated it.
_ENGINE_ABSENT_MARKERS = (
    "failed to import coqui-tts",
    "pytorch missing from this venv",
    "no module named",
)


def engine_absent_reason(exc: BaseException) -> Optional[str]:
    """Return a skip reason iff `exc` means the engine is not installed on
    this box; return None for every other failure, which the caller must let
    propagate.

    Note what is deliberately NOT here: `VoiceNotDesignedError` (a
    `RuntimeError` subclass, so type-based matching would have swept it in),
    `AssertionError`, and every CUDA/runtime error. Those are results, not
    missing prerequisites."""
    if isinstance(exc, ImportError):
        return f"engine package not installed on this box: {exc}"
    message = str(exc).lower()
    for marker in _ENGINE_ABSENT_MARKERS:
        if marker in message:
            return f"engine not installed on this box: {exc}"
    return None


def synthesise_or_skip(engine: Any, model: str, voice: str, text: str) -> Any:
    """`engine.synthesize(...)`, skipping ONLY if the engine is absent.

    Use this for the FIRST synth in a golden test — the one whose failure can
    still legitimately mean "this box has no Coqui" (or, since #1987, "no
    Kokoro" for `_make_kokoro`'s warm-up call). Any later call in the same
    test should invoke `engine.synthesize` directly: once the first render
    has succeeded the engine is demonstrably present, so a second failure is
    a regression by definition and must not be skippable."""
    try:
        return engine.synthesize(model, voice, text)
    except Exception as exc:
        reason = engine_absent_reason(exc)
        if reason is None:
            raise
        pytest.skip(reason)


def pick_designed_voice(voices: list[str], override: Optional[str]) -> Optional[str]:
    """Select which designed voice a golden run drives against. An explicit
    override (e.g. GOLDEN_QWEN_VOICE) always wins; otherwise the first of
    `voices` (caller passes them pre-sorted, e.g. QwenEngine.list_voices())
    is used, so the golden gate fires with NO opt-in env var required on any
    box that already has at least one designed voice (#1994). Returns None
    when neither is available, so the caller can skip cleanly."""
    if override:
        return override
    return voices[0] if voices else None
