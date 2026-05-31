"""side-5 — the benign Qwen ``code_predictor_config is None`` load line is
dropped by the load-time log filter without muting unrelated records, and the
filter never leaks past the load."""

import logging
import sys
from pathlib import Path

# Make the sidecar package importable: tests/ sits one level below main.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402

NEEDLE = "code_predictor_config is None"


def _record(msg: str) -> logging.LogRecord:
    return logging.LogRecord("sidecar", logging.WARNING, __file__, 1, msg, None, None)


def test_drops_code_predictor_config_line() -> None:
    flt = main._DropSubstringLogFilter(NEEDLE)
    dropped = _record(
        "code_predictor_config is None. Initializing code_predictor model "
        "with default values"
    )
    assert flt.filter(dropped) is False


def test_keeps_unrelated_records() -> None:
    flt = main._DropSubstringLogFilter(NEEDLE)
    kept = _record("Qwen model=Base attn_implementation=sdpa device=cuda")
    assert flt.filter(kept) is True


def test_suppress_context_manager_is_balanced() -> None:
    """Filters added during the load must be removed afterwards (no leak)."""
    root = logging.getLogger()
    before = {id(h): list(h.filters) for h in root.handlers}
    with main._suppress_code_predictor_log():
        pass
    after = {id(h): list(h.filters) for h in root.handlers}
    assert after == before
