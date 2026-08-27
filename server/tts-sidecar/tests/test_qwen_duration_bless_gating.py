"""`_bless()` caller-side wiring for qwen-duration-baseline.json's tolerance
derivation (#1994).

`test_qwen_duration_golden.py` is `@pytest.mark.golden` (it needs the real Qwen
0.6B-Base weights + CUDA), but `_bless()` itself is pure file I/O plus tolerance
computation — no model, no GPU. This drives it DIRECTLY as a plain function call
(no pytest marker), the same technique `test_golden_sanity_gating.py` uses to pin
`test_golden_regression.py`'s bless/content gates in the normal fast `test:sidecar`
tier: importing a `golden`-marked module and calling one of its functions is an
ordinary Python call, not a pytest collection, so the module-level `pytestmark`
never attaches to these test items.

This file tests:
- Fix 1: Tolerance is updated by `_bless()` (not left at placeholder 0.05)
- Fix 3: Only the first synthesis uses `synthesise_or_skip` (verified structurally
  via the function's expected behavior)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from tests.golden import test_qwen_duration_golden as qwen  # noqa: E402


def _write_baseline(tmp_path: Path) -> Path:
    """Create a fresh unblessed qwen-duration-baseline.json with placeholder tolerance."""
    path = tmp_path / "qwen-duration-baseline.json"
    data = {
        "_comment": "Unblessed (#1994). Placeholder tolerance — replace after first bless.",
        "tolerance": 0.05,  # placeholder
        "entries": {},
    }
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


def _make_mock_synthesize_result(sample_count: int) -> MagicMock:
    """Mock a synthesis result with the given sample count."""
    result = MagicMock()
    # PCM is (sample_count * 2) bytes (16-bit samples)
    result.pcm = bytes(sample_count * 2)
    result.sample_rate = 24000
    result.substituted_from = None
    return result


def test_bless_updates_tolerance_from_observed_spread(monkeypatch, tmp_path) -> None:
    """Fix 1: The tolerance must be computed from the observed spread and written
    to the baseline, not left at the placeholder 0.05."""
    path = _write_baseline(tmp_path)
    monkeypatch.setattr(qwen, "BASELINE_PATH", path)
    monkeypatch.setattr(qwen, "FIXTURE_PATH", tmp_path / "fixture.json")

    # Mock fixture with 3 lines of varying sample counts
    fixture = {
        "lines": [
            {"id": "line1", "text": "Test one."},
            {"id": "line2", "text": "Test two."},
            {"id": "line3", "text": "Test three."},
        ]
    }
    monkeypatch.setattr(qwen, "_load_json", lambda p: fixture if p == qwen.FIXTURE_PATH else {})

    # Mock engine and synthesise_or_skip to return results with observable spread
    # Samples: 24000, 29000, 19000 — mean ~24000, max deviation ~20%, tolerance ~25%
    sample_counts = [24000, 29000, 19000]
    results = [_make_mock_synthesize_result(sc) for sc in sample_counts]

    call_count_engine = [0]

    def mock_synthesize(model, voice, text):
        result = results[call_count_engine[0]]
        call_count_engine[0] += 1
        return result

    mock_engine = MagicMock()
    mock_engine.synthesize = mock_synthesize

    with patch.object(qwen, "synthesise_or_skip") as mock_skip:
        # First call (warm-up) uses synthesise_or_skip, returns first result
        mock_skip.return_value = results[0]
        qwen._bless(mock_engine, "test_voice", fixture)

    written = json.loads(path.read_text(encoding="utf-8"))
    # Tolerance should be updated from the observed spread, not stay at 0.05
    assert written["tolerance"] != 0.05, "tolerance must be updated from placeholder"
    # With observable spread, tolerance should be > 0.05 and <= 0.25 (the cap)
    assert 0.05 < written["tolerance"] <= 0.25, f"tolerance should be in (0.05, 0.25], got {written['tolerance']}"
    # Check that entries were recorded
    assert len(written["entries"]) == 3
    assert "line1" in written["entries"]


def test_bless_uses_synthesise_or_skip_only_for_first_line(monkeypatch, tmp_path) -> None:
    """Fix 3: `synthesise_or_skip` is used only for warm-up (first line); later
    lines call `engine.synthesize` directly so a real failure surfaces as FAIL."""
    path = _write_baseline(tmp_path)
    monkeypatch.setattr(qwen, "BASELINE_PATH", path)
    monkeypatch.setattr(qwen, "FIXTURE_PATH", tmp_path / "fixture.json")

    fixture = {
        "lines": [
            {"id": "line1", "text": "Test one."},
            {"id": "line2", "text": "Test two."},
            {"id": "line3", "text": "Test three."},
        ]
    }
    monkeypatch.setattr(qwen, "_load_json", lambda p: fixture if p == qwen.FIXTURE_PATH else {})

    results = [_make_mock_synthesize_result(24000) for _ in range(3)]

    # Track which method is called for each synthesis
    synthesize_calls = []
    skip_calls = []

    def mock_synthesize(model, voice, text):
        synthesize_calls.append((model, voice, text))
        return results[len(synthesize_calls) - 1]

    mock_engine = MagicMock()
    mock_engine.synthesize = mock_synthesize

    with patch.object(qwen, "synthesise_or_skip") as mock_skip:
        def mock_skip_impl(*args, **kwargs):
            skip_calls.append(args)
            return results[0]

        mock_skip.side_effect = mock_skip_impl
        qwen._bless(mock_engine, "test_voice", fixture)

    # First call should use synthesise_or_skip (1 call)
    assert len(skip_calls) == 1, f"synthesise_or_skip should be called exactly once (warm-up), was {len(skip_calls)}"
    # Remaining 2 calls should use engine.synthesize directly
    assert len(synthesize_calls) == 2, f"engine.synthesize should be called exactly 2 times (lines 2-3), was {len(synthesize_calls)}"


def test_bless_tolerance_placeholder_when_single_line(monkeypatch, tmp_path) -> None:
    """When the fixture has only 1 line, `_compute_tolerance` returns the
    placeholder (0.10) since there's no observed spread to measure."""
    path = _write_baseline(tmp_path)
    monkeypatch.setattr(qwen, "BASELINE_PATH", path)
    monkeypatch.setattr(qwen, "FIXTURE_PATH", tmp_path / "fixture.json")

    fixture = {"lines": [{"id": "line1", "text": "Test one."}]}
    monkeypatch.setattr(qwen, "_load_json", lambda p: fixture if p == qwen.FIXTURE_PATH else {})

    mock_engine = MagicMock()
    results = [_make_mock_synthesize_result(24000)]

    call_count = [0]
    def mock_synthesize(model, voice, text):
        result = results[call_count[0]]
        call_count[0] += 1
        return result

    mock_engine.synthesize = mock_synthesize

    with patch.object(qwen, "synthesise_or_skip") as mock_skip:
        mock_skip.return_value = results[0]
        qwen._bless(mock_engine, "test_voice", fixture)

    written = json.loads(path.read_text(encoding="utf-8"))
    # With only 1 sample, tolerance falls back to placeholder 0.10
    assert written["tolerance"] == 0.10


def test_compute_tolerance_bounds_result_at_ceiling(monkeypatch, tmp_path) -> None:
    """_compute_tolerance caps the result at 0.25 even if observed spread is larger."""
    # This is a structural test of the helper function itself
    path = _write_baseline(tmp_path)
    monkeypatch.setattr(qwen, "BASELINE_PATH", path)
    monkeypatch.setattr(qwen, "FIXTURE_PATH", tmp_path / "fixture.json")

    fixture = {
        "lines": [
            {"id": "line1", "text": "Test one."},
            {"id": "line2", "text": "Test two."},
            {"id": "line3", "text": "Test three."},
        ]
    }
    monkeypatch.setattr(qwen, "_load_json", lambda p: fixture if p == qwen.FIXTURE_PATH else {})

    # Create extreme spread: 10000, 50000, 10000 samples (~100% deviation)
    # Without the cap, tolerance would be ~125% (way too high)
    # Mean = 23333, max deviation from mean = 26667/23333 = 114.3%, * 1.25 = 143% > 0.25 cap
    extreme_counts = [10000, 50000, 10000]
    results = [_make_mock_synthesize_result(sc) for sc in extreme_counts]

    call_count_engine = [0]
    def mock_synthesize(model, voice, text):
        result = results[call_count_engine[0]]
        call_count_engine[0] += 1
        return result

    mock_engine = MagicMock()
    mock_engine.synthesize = mock_synthesize

    with patch.object(qwen, "synthesise_or_skip") as mock_skip:
        mock_skip.return_value = results[0]
        qwen._bless(mock_engine, "test_voice", fixture)

    written = json.loads(path.read_text(encoding="utf-8"))
    # Must be capped at 0.25
    assert written["tolerance"] == 0.25, "tolerance must be capped at 0.25"
