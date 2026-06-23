"""Pin the deployer-facing warning suppression (backlog side-2).

`configure_warning_filters()` (server/tts-sidecar/warning_filters.py) silences
three benign-but-scary warnings the Qwen install + first model load emit on a
clean Windows box: the HF Hub symlink warning, the torchaudio/coqui
`SoX could not be found!` probe, and the transformers `flash-attn is not
installed` banner. This regression catches drift in any of the three.

Intentionally import-cheap: warning_filters.py imports only os + warnings, so
this runs without numpy/fastapi/torch (i.e. without loading all of main)."""
from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import warning_filters  # noqa: E402


def test_sets_hf_symlink_env() -> None:
    """The HF Hub symlink warning is silenced via the env knob HF Hub reads."""
    # Clear any inherited value so we prove the function sets it.
    os.environ.pop("HF_HUB_DISABLE_SYMLINKS_WARNING", None)
    warning_filters.configure_warning_filters()
    assert os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] == "1"


def test_registers_sox_and_flash_attn_filters() -> None:
    """Both noise probes are silenced by narrow message-scoped filters, so
    the deployer console isn't littered with no-op warnings."""
    # Start from a known filter list, then re-register.
    with warnings.catch_warnings():
        warnings.resetwarnings()
        warning_filters.configure_warning_filters()
        # warnings.filters entries: (action, message_regex, category, module, lineno).
        # message_regex is a compiled pattern (or None for category-only filters).
        patterns = [
            msg.pattern
            for (action, msg, *_rest) in warnings.filters
            if action == "ignore" and msg is not None
        ]

    joined = " | ".join(patterns)
    assert "SoX could not be found" in joined
    assert "flash" in joined and "is not installed" in joined
    # issue #1024: the PYTORCH_CUDA_ALLOC_CONF=expandable_segments flag we set in
    # main.py is a no-op on a Windows torch build without support — torch emits a
    # benign "expandable_segments not supported on this platform" UserWarning.
    assert "expandable_segments not supported" in joined


def test_actually_suppresses_the_messages() -> None:
    """Behavioural check: with the filters registered, emitting the SoX and
    flash-attn messages produces no captured warning."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.resetwarnings()
        warnings.simplefilter("always")
        warning_filters.configure_warning_filters()
        warnings.warn("SoX could not be found!", UserWarning)
        warnings.warn("flash-attn is not installed. Using SDPA.", UserWarning)
        warnings.warn("expandable_segments not supported on this platform", UserWarning)
    assert caught == [], f"expected suppression, got: {[str(w.message) for w in caught]}"


def test_idempotent() -> None:
    """Calling it twice is safe (env setdefault + duplicate filters harmless)."""
    warning_filters.configure_warning_filters()
    warning_filters.configure_warning_filters()
    assert warning_filters.WARNING_FILTERS_CONFIGURED is True
