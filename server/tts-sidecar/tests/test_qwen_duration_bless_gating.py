"""`_bless()` caller-side wiring for qwen-duration-baseline.json (#1994).

`test_qwen_duration_golden.py` is `@pytest.mark.golden` (it needs the real Qwen
0.6B-Base weights + CUDA), but `_bless()` itself is pure file I/O — no model,
no GPU. This drives it DIRECTLY as a plain function call (no pytest marker),
the same technique `test_golden_sanity_gating.py` uses to pin
`test_golden_regression.py`'s bless/content gates in the normal fast `test:sidecar`
tier: importing a `golden`-marked module and calling one of its functions is an
ordinary Python call, not a pytest collection, so the module-level `pytestmark`
never attaches to these test items.

This file tests:
- Only the first synthesis uses `synthesise_or_skip` (verified structurally
  via the function's expected behavior)
- Tolerance remains at static placeholder (0.10) from the committed baseline
- The assertion loop's warm-up runs even when the FIRST fixture line's
  baseline entry happens to be missing (a missing-entries check must not
  short-circuit past the warm-up, or a later line's direct engine call loses
  its SKIP protection — see `test_assertion_loop_warms_up_before_missing_entry_check`)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
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


def test_bless_tolerance_never_touched(monkeypatch, tmp_path) -> None:
    """_bless does NOT overwrite tolerance — it preserves whatever is already
    in the baseline file.

    Real tolerance derivation from an actual N-repeat on-box measurement
    remains register row A38's owed acceptance work, not this scaffold's job.

    When an operator hand-sets a real tolerance (e.g., 0.15 from on-box
    measurement), a subsequent `--bless` (e.g., to refresh entries after a
    code change) must NOT silently clobber it back to the placeholder."""
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

    # Seed the baseline with a hand-measured real tolerance (not the placeholder)
    # to simulate an operator who ran on-box acceptance and set a real value.
    real_baseline = json.loads(path.read_text(encoding="utf-8"))
    real_baseline["tolerance"] = 0.15  # hand-set, not the default placeholder
    path.write_text(json.dumps(real_baseline, indent=2) + "\n", encoding="utf-8")

    # Mock _load_json to return the fixture when requested, or the baseline
    def mock_load(p):
        if p == qwen.FIXTURE_PATH:
            return fixture
        elif p == qwen.BASELINE_PATH:
            return json.loads(p.read_text(encoding="utf-8"))
        return {}

    monkeypatch.setattr(qwen, "_load_json", mock_load)

    mock_engine = MagicMock()
    results = [_make_mock_synthesize_result(24000) for _ in range(3)]

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
    # Tolerance must remain at the hand-set value (0.15), NOT be clobbered to 0.10
    assert written["tolerance"] == 0.15, f"tolerance should remain at hand-set value 0.15, but got {written['tolerance']}"
    # Check that all entries were recorded
    assert len(written["entries"]) == 3
    assert all(f"line{i}" in written["entries"] for i in range(1, 4))


def test_assertion_loop_warms_up_before_missing_entry_check(monkeypatch) -> None:
    """The main assertion test (`test_qwen_golden_lengths_match_baseline`) must
    run its first-line warm-up (`synthesise_or_skip`) BEFORE checking whether
    that line has a baseline entry — not after.

    If a fixture edit drops/renames the first line's id so its baseline entry
    goes missing, a "missing entry -> continue" check placed BEFORE the
    warm-up branch would skip the warm-up entirely for line 0, leaving line 1's
    direct `engine.synthesize()` call with no SKIP protection: an absent
    engine would surface as a raw uncaught exception instead of a clean SKIP.
    Reproduces the exact bug pass-3 review found still present after the
    `_bless`-only warm-up fix (the assertion loop was never restructured to
    match)."""
    fixture = {
        "lines": [
            {"id": "line1", "text": "Test one."},
            {"id": "line2", "text": "Test two."},
        ]
    }
    baseline = {
        "tolerance": 0.10,
        # line1 deliberately missing — simulates a fixture edit that dropped
        # or renamed the first line's id without a re-bless.
        "entries": {
            "line2": {"sample_rate": 24000, "sample_count": 24000, "duration_sec": 1.0},
        },
    }

    def mock_load(p):
        return fixture if p == qwen.FIXTURE_PATH else baseline

    monkeypatch.setattr(qwen, "_load_json", mock_load)
    monkeypatch.setattr(qwen, "_resolve_voice", lambda engine: "test_voice")
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)

    results = [_make_mock_synthesize_result(24000), _make_mock_synthesize_result(24000)]
    skip_calls = []
    synth_calls = []

    def mock_synthesize(model, voice, text):
        synth_calls.append((model, voice, text))
        return results[len(synth_calls) - 1]

    mock_engine = MagicMock()
    mock_engine.synthesize = mock_synthesize
    monkeypatch.setattr(qwen, "_make_qwen", lambda: mock_engine)

    def mock_skip_impl(*args, **kwargs):
        skip_calls.append(args)
        return results[0]

    with patch.object(qwen, "synthesise_or_skip") as mock_skip:
        mock_skip.side_effect = mock_skip_impl
        # line1 has no baseline entry, so this always fails the "no baseline
        # entry" check regardless of warm-up ordering — the assertion here is
        # a red herring for the actual thing under test, which is the CALL
        # ORDERING captured below.
        with pytest.raises(AssertionError):
            qwen.test_qwen_golden_lengths_match_baseline()

    assert len(skip_calls) == 1, (
        "synthesise_or_skip (warm-up) must run for the first line even though "
        f"its baseline entry is missing, got {len(skip_calls)} calls — a "
        "missing-entry check placed before the warm-up branch would skip it "
        "entirely, leaving the next line's direct engine call unprotected."
    )
    assert len(synth_calls) == 1, f"engine.synthesize should be called exactly once (line 2), was {len(synth_calls)}"


