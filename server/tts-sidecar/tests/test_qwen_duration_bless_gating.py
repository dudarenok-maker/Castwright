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
- `_bless` uses `synthesise_or_skip` only for line 1 (warm-up); every later
  line calls the engine directly — an ORDERED call log, not a count, so an
  `i == 0` -> `i == 1` swap can't survive with matching counts
  (`test_bless_uses_synthesise_or_skip_only_for_first_line`)
- `_bless` never touches `tolerance` — it preserves whatever's already in
  the baseline file (placeholder or a hand-set real value), and stamps
  `entries[*]["voice"]` + a `metadata` block on every bless
  (`test_bless_tolerance_never_touched`)
- The assertion loop flags a baseline entry recorded against a DIFFERENT
  Qwen voice than this run resolved — Qwen voices are runtime-resolved, not
  a fixed per-line catalog like Kokoro's
  (`test_assertion_loop_flags_voice_mismatch_against_baseline`)
- …but does NOT flag a baseline entry with no recorded `voice` key at all
  (backward-compatible with a pre-#1994-review baseline shape) — the
  guard's `is not None` half, deliberately untested by the mismatch case
  above (`test_assertion_loop_tolerates_missing_voice_key_in_baseline_entry`)
- The assertion loop's warm-up runs even when the FIRST fixture line's
  baseline entry happens to be missing (a missing-entries check must not
  short-circuit past the warm-up, or a later line's direct engine call loses
  its SKIP protection — `test_assertion_loop_warms_up_before_missing_entry_check`)
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
        "_comment": "#1994. tolerance is a PLACEHOLDER until an operator hand-sets a real measured value.",
        "tolerance": 0.10,  # placeholder, matches the real committed baseline's current value
        "entries": {},
    }
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


def _make_mock_synthesize_result(sample_count: int) -> MagicMock:
    """Mock a synthesis result with the given sample count. PCM is all-zero
    (silent) -- fine for tests that only care about sample_count/sample_rate
    comparisons, but a real RMS check (rms() on all-zero bytes returns 0.0)
    will trip a near-silence failure. Use
    `_make_mock_synthesize_result_audible` when the test needs to actually
    pass the RMS floor."""
    result = MagicMock()
    # PCM is (sample_count * 2) bytes (16-bit samples)
    result.pcm = bytes(sample_count * 2)
    result.sample_rate = 24000
    result.substituted_from = None
    return result


def _make_mock_synthesize_result_audible(sample_count: int) -> MagicMock:
    """Like `_make_mock_synthesize_result`, but with real (non-silent) 16-bit
    PCM content, so `rms()` clears `MIN_RMS` -- for tests that must pass a
    real synthesis end to end without near-silence tripping first."""
    import struct

    # A constant mid-scale amplitude is well above MIN_RMS (0.01) without
    # needing an actual waveform -- this test cares about RMS clearing the
    # floor, not about the audio being realistic.
    amplitude = 8000
    pcm = struct.pack(f"<{sample_count}h", *([amplitude] * sample_count))
    result = MagicMock()
    result.pcm = pcm
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

    # A single ORDERED call log, tagged by which path was used — not two
    # separate counters. Two counters can't tell "warm-up first, direct
    # after" from "direct first, warm-up in the middle": swap which index
    # uses which path and the counts (1 skip, 2 direct) stay identical, so a
    # count-only assertion can't catch an `i == 0` -> `i == 1` mutation. The
    # order captured here can.
    call_log = []

    def mock_synthesize(model, voice, text):
        call_log.append("direct")
        return results[len(call_log) - 1]

    mock_engine = MagicMock()
    mock_engine.synthesize = mock_synthesize

    with patch.object(qwen, "synthesise_or_skip") as mock_skip:
        def mock_skip_impl(*args, **kwargs):
            call_log.append("skip")
            return results[len(call_log) - 1]

        mock_skip.side_effect = mock_skip_impl
        qwen._bless(mock_engine, "test_voice", fixture)

    assert call_log == ["skip", "direct", "direct"], (
        f"expected warm-up (skip) for line 1 only, then direct calls for "
        f"lines 2-3, got {call_log}"
    )


def test_bless_tolerance_never_touched(monkeypatch, tmp_path) -> None:
    """_bless does NOT overwrite tolerance — it preserves whatever is already
    in the baseline file.

    Real tolerance derivation from an actual N-repeat on-box measurement was
    register row A101's owed acceptance work — now discharged (hand-set to
    0.30 in the committed baseline), but this scaffold-level guarantee
    (never clobbered by a routine `--bless`) still needs its own coverage.

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
    # Each entry must record which voice it was synthesised against (#1994
    # review pass-2 finding): the assertion loop's voice-mismatch check reads
    # this field back, and treats an ABSENT key as "no check" (backward
    # compatible with a pre-#1994-review baseline shape) -- so if _bless ever
    # stopped writing it, that check would silently become a permanent no-op
    # rather than failing loudly. Pin that it's actually written.
    assert all(
        written["entries"][f"line{i}"]["voice"] == "test_voice" for i in range(1, 4)
    ), f"every entry must record the voice it was synthesised against, got {written['entries']}"
    # #2004 precedent (kokoro-baseline.json): a bless stamps engine/package
    # version metadata "so a model bump is legible" -- pin that Qwen's bless
    # does too, and doesn't quietly stop.
    assert "metadata" in written, "bless must stamp a metadata block (qwen_tts_version/torch_version/blessed_at)"
    assert set(written["metadata"].keys()) >= {"qwen_tts_version", "torch_version", "blessed_at"}


def test_assertion_loop_flags_voice_mismatch_against_baseline(monkeypatch) -> None:
    """A baseline entry recorded against a different Qwen voice must not be
    silently compared against — Qwen voices are runtime-resolved
    (`pick_designed_voice`: sorted, first wins, absent an override), unlike
    Kokoro's fixed per-line-pinned catalog, so a voice change between bless
    and this run means the recorded duration belongs to a different speaker
    entirely. This is this file's substitute for Kokoro's `substituted_from`
    check, which can never fire on Qwen (QwenEngine.synthesize never sets
    that field — see the comment in the assertion loop)."""
    fixture = {"lines": [{"id": "line1", "text": "Test one."}]}
    baseline = {
        "tolerance": 0.10,
        "entries": {
            "line1": {
                "voice": "voice_a",
                "sample_rate": 24000,
                "sample_count": 24000,
                "duration_sec": 1.0,
            },
        },
    }

    def mock_load(p):
        return fixture if p == qwen.FIXTURE_PATH else baseline

    monkeypatch.setattr(qwen, "_load_json", mock_load)
    # Runtime resolves a DIFFERENT voice than the baseline was recorded against.
    monkeypatch.setattr(qwen, "_resolve_voice", lambda engine: "voice_b")
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)

    result = _make_mock_synthesize_result(24000)
    monkeypatch.setattr(qwen, "_make_qwen", lambda: MagicMock())

    with patch.object(qwen, "synthesise_or_skip", return_value=result):
        with pytest.raises(AssertionError, match="voice_a.*voice_b|voice mismatch|re-bless after a voice change"):
            qwen.test_qwen_golden_lengths_match_baseline()


def test_assertion_loop_tolerates_missing_voice_key_in_baseline_entry(monkeypatch) -> None:
    """A baseline entry with NO recorded `voice` key must NOT be treated as a
    mismatch — this is the `is not None` half of the voice-mismatch check's
    guard, deliberately untested by the sibling mismatch test above (which
    always seeds a recorded voice). Passes cleanly end to end (no
    AssertionError) with matching audio, proving the check is a no-op rather
    than a false positive when `voice` is absent. Kills the mutation where
    `if recorded_voice is not None and recorded_voice != voice:` loses its
    `is not None` guard, which would make ANY recorded-voice-absent entry
    compare `None != voice` (always true) and fail every such line."""
    fixture = {"lines": [{"id": "line1", "text": "Test one."}]}
    baseline = {
        "tolerance": 0.10,
        "entries": {
            # No "voice" key at all -- the shape a pre-#1994-review baseline
            # (or any hand-edited one) would have.
            "line1": {"sample_rate": 24000, "sample_count": 24000, "duration_sec": 1.0},
        },
    }

    def mock_load(p):
        return fixture if p == qwen.FIXTURE_PATH else baseline

    monkeypatch.setattr(qwen, "_load_json", mock_load)
    monkeypatch.setattr(qwen, "_resolve_voice", lambda engine: "whichever_voice")
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)

    # Sample count/rate match the baseline entry exactly and RMS is well
    # above MIN_RMS, so every OTHER check in the loop passes too -- the only
    # thing that could raise is a voice-mismatch false positive.
    result = _make_mock_synthesize_result_audible(24000)
    monkeypatch.setattr(qwen, "_make_qwen", lambda: MagicMock())

    with patch.object(qwen, "synthesise_or_skip", return_value=result):
        qwen.test_qwen_golden_lengths_match_baseline()  # must not raise


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
    # A single ORDERED call log (see the sibling bless test above for why
    # counts alone can't catch an `i == 0` -> `i == 1` mutation).
    call_log = []

    def mock_synthesize(model, voice, text):
        call_log.append("direct")
        return results[len(call_log) - 1]

    mock_engine = MagicMock()
    mock_engine.synthesize = mock_synthesize
    monkeypatch.setattr(qwen, "_make_qwen", lambda: mock_engine)

    def mock_skip_impl(*args, **kwargs):
        call_log.append("skip")
        return results[len(call_log) - 1]

    with patch.object(qwen, "synthesise_or_skip") as mock_skip:
        mock_skip.side_effect = mock_skip_impl
        # line1 has no baseline entry, so this always fails the "no baseline
        # entry" check regardless of warm-up ordering — the assertion here is
        # a red herring for the actual thing under test, which is the CALL
        # ORDERING captured below.
        with pytest.raises(AssertionError):
            qwen.test_qwen_golden_lengths_match_baseline()

    assert call_log == ["skip", "direct"], (
        "synthesise_or_skip (warm-up) must run for the first line even though "
        f"its baseline entry is missing, got {call_log} — a missing-entry "
        "check placed before the warm-up branch would skip it entirely, "
        "leaving the next line's direct engine call unprotected."
    )


