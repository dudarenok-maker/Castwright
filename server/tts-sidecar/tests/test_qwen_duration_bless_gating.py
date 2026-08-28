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
- `_bless` uses `synthesise_or_skip` only for the very first synthesis of
  the whole bless (line 1's first rep); every other call goes straight to
  the engine — an ORDERED call log, not a count, so an `i == 0` -> `i == 1`
  swap can't survive with matching counts
  (`test_bless_uses_synthesise_or_skip_only_for_first_line`)
- `_bless` blesses the MEAN duration/sample_count across `BLESS_REPS`
  repeated real syntheses per line, not a single draw — #1994 review
  finding C1: `tolerance` bounds how far a single fresh draw can land from
  the population's TRUE mean, so the blessed reference must itself
  approximate that mean (`test_bless_averages_across_reps`)
- `_bless` never touches `tolerance` — it preserves whatever's already in
  the baseline file (placeholder or a hand-set real value), and stamps
  `entries[*]["voice"]` + a `metadata` block on every bless
  (`test_bless_tolerance_never_touched`)
- The assertion loop SKIPS (not fails) when the baseline's entries were
  blessed against a DIFFERENT Qwen voice than this run resolved — #1994
  review finding C3: Qwen voices are runtime-resolved, not a fixed per-line
  catalog like Kokoro's, so a voice mismatch means "this box hasn't been
  measured", not "a regression was detected"
  (`test_assertion_loop_skips_on_voice_mismatch_against_baseline`)
- …but does NOT skip when the resolved voice MATCHES the baseline's — the
  only voice configuration the gate ever actually asserts under, and the
  one case that catches a mutant which skips on ANY recorded voice
  regardless of match (`test_assertion_loop_does_not_skip_when_voice_matches`)
- …and does NOT skip on a baseline entry with no recorded `voice` key at all
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
        "tolerance": 0.10,  # placeholder for these unit tests; independent of the real committed baseline
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


def test_bless_uses_synthesise_or_skip_only_for_the_warmup(monkeypatch, tmp_path) -> None:
    """Fix 3: `synthesise_or_skip` is used only for the discarded warm-up
    call, made once before any line's averaged reps; every timed rep across
    every line goes straight to `engine.synthesize` so a real failure
    surfaces as FAIL, not a swallowed SKIP. The warm-up is a SEPARATE call
    from every line's BLESS_REPS reps (#1994 review-round-2 finding N6: the
    warm-up used to double as line 1's first averaged rep, folding one cold
    draw into what should be BLESS_REPS equally-warm draws) — this test's
    call count (1 skip + 3*BLESS_REPS direct, not 1 skip + 3*BLESS_REPS - 1)
    pins that separation."""
    path = _write_baseline(tmp_path)
    monkeypatch.setattr(qwen, "BASELINE_PATH", path)
    monkeypatch.setattr(qwen, "FIXTURE_PATH", tmp_path / "fixture.json")
    monkeypatch.setattr(qwen, "BLESS_REPS", 2)

    fixture = {
        "lines": [
            {"id": "line1", "text": "Test one."},
            {"id": "line2", "text": "Test two."},
            {"id": "line3", "text": "Test three."},
        ]
    }
    monkeypatch.setattr(qwen, "_load_json", lambda p: fixture if p == qwen.FIXTURE_PATH else {})

    results = [_make_mock_synthesize_result(24000) for _ in range(7)]

    # A single ORDERED call log, tagged by which path was used — not two
    # separate counters. Two counters can't tell "warm-up first, direct
    # after" from "direct first, warm-up in the middle": swap which index
    # uses which path and the counts (1 skip, 6 direct) stay identical, so a
    # count-only assertion can't catch an ordering mutation. The order
    # captured here can.
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

    assert call_log == ["skip"] + ["direct"] * 6, (
        f"expected a single warm-up (skip) call, then direct calls for "
        f"every rep across all 3 lines (2 reps each = 6), got {call_log}"
    )


def test_bless_averages_across_reps(monkeypatch, tmp_path) -> None:
    """_bless's blessed duration/sample_count is the MEAN across `BLESS_REPS`
    repeated real syntheses, not a single draw (#1994 review finding C1):
    `tolerance` bounds how far a single fresh draw at ASSERT time can land
    from the population's TRUE mean, so the reference `_bless` writes must
    itself approximate that mean — an arbitrary single draw could sit
    anywhere in the distribution. Kills a mutant that blesses only the
    first/last rep instead of averaging across all `BLESS_REPS` — including
    a "bless rep 0 only" mutant, i.e. the exact pre-fix C1 behaviour: that
    is why `sample_counts[0]` below is NOT equal to the mean (#1994
    review-round-2 finding C4: an earlier version of this fixture had
    `sample_counts[0] == mean` by coincidence, so a "rep 0 only" mutant
    produced the SAME stored value as the real averaging code and the test
    could not fail for the one mutation it exists to catch)."""
    path = _write_baseline(tmp_path)
    monkeypatch.setattr(qwen, "BASELINE_PATH", path)
    monkeypatch.setattr(qwen, "FIXTURE_PATH", tmp_path / "fixture.json")
    monkeypatch.setattr(qwen, "BLESS_REPS", 3)

    fixture = {"lines": [{"id": "line1", "text": "Test one."}]}
    monkeypatch.setattr(qwen, "_load_json", lambda p: fixture if p == qwen.FIXTURE_PATH else {})

    # Three distinct sample counts (at 24000 Hz: 0.9s, 1.1s, 1.0s) whose mean
    # duration (1.0s) and mean sample_count (24000) are exact round numbers,
    # so the assertion below can't be confused by rounding -- and whose
    # FIRST value (21600, index 0) is deliberately NOT the mean, so a mutant
    # that blesses only rep 0 produces a different, wrong stored value.
    sample_counts = [21600, 26400, 24000]
    results = [_make_mock_synthesize_result(c) for c in sample_counts]

    direct_results = iter(results)

    def mock_synthesize(model, voice, text):
        return next(direct_results)

    mock_engine = MagicMock()
    mock_engine.synthesize = mock_synthesize

    # The discarded warm-up returns a wildly different sample_count -- if it
    # were ever folded into the average (the pre-N6-fix behaviour), the
    # assertions below would catch that too.
    warmup_result = _make_mock_synthesize_result(999999)
    with patch.object(qwen, "synthesise_or_skip", return_value=warmup_result):
        qwen._bless(mock_engine, "test_voice", fixture)

    written = json.loads(path.read_text(encoding="utf-8"))
    entry = written["entries"]["line1"]
    assert entry["sample_count"] == 24000, f"expected mean sample_count 24000, got {entry['sample_count']}"
    assert abs(entry["duration_sec"] - 1.0) < 1e-6, f"expected mean duration_sec 1.0, got {entry['duration_sec']}"


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
    # Not testing averaging here (see test_bless_averages_across_reps) — one
    # rep per line keeps this test's call-count bookkeeping simple.
    monkeypatch.setattr(qwen, "BLESS_REPS", 1)

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
    assert set(written["metadata"].keys()) >= {"qwen_tts_version", "torch_version", "blessed_at", "bless_reps"}
    assert written["metadata"]["bless_reps"] == 1


def test_assertion_loop_skips_on_voice_mismatch_against_baseline(monkeypatch) -> None:
    """A baseline whose entries were blessed against a DIFFERENT Qwen voice
    than this run resolved is SKIPPED, not failed. Qwen voices are
    runtime-resolved (`pick_designed_voice`: sorted, first wins, absent an
    override), unlike Kokoro's fixed per-line-pinned catalog, so a box with
    a different designed voice has no applicable baseline — exactly like an
    empty-`entries` baseline, which also skips. Treating a voice mismatch as
    a FAILURE (the pre-fix behaviour) hard-fails every box whose first
    designed voice happens to sort before the blessed one even though
    nothing regressed — #1994 review finding C3. This is this file's
    substitute for Kokoro's `substituted_from` check, which can never fire
    on Qwen (QwenEngine.synthesize never sets that field — see the comment
    in the assertion loop)."""
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
    # Runtime resolves a DIFFERENT voice than the baseline was blessed against.
    monkeypatch.setattr(qwen, "_resolve_voice", lambda engine: "voice_b")
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)
    monkeypatch.setattr(qwen, "_make_qwen", lambda: MagicMock())

    # The mismatch is checked up front, before any synthesis, so
    # synthesise_or_skip is never actually invoked here — nothing to mock.
    with pytest.raises(pytest.skip.Exception, match="voice_a.*voice_b|voice"):
        qwen.test_qwen_golden_lengths_match_baseline()


def test_assertion_loop_does_not_skip_when_voice_matches(monkeypatch) -> None:
    """A baseline entry blessed against the SAME voice this run resolved must
    proceed to the real comparison, not skip. This is the only voice
    configuration the golden gate ever actually asserts under, and neither
    sibling test below covers it: the mismatch test's `recorded_voices` set
    is always non-empty AND never contains the resolved voice, and the
    missing-key test's `recorded_voices` set is always empty — both leave
    `if recorded_voices:` (dropping the `voice not in recorded_voices` half
    entirely) free to skip on ANY recorded voice, matched or not, and still
    pass. Kills exactly that mutant (#1994 review-round-2 finding M3:
    survived 11/11 green with no test covering this case)."""
    fixture = {"lines": [{"id": "line1", "text": "Test one."}]}
    baseline = {
        "tolerance": 0.10,
        "entries": {
            "line1": {
                "voice": "matching_voice",
                "sample_rate": 24000,
                "sample_count": 24000,
                "duration_sec": 1.0,
            },
        },
    }

    def mock_load(p):
        return fixture if p == qwen.FIXTURE_PATH else baseline

    monkeypatch.setattr(qwen, "_load_json", mock_load)
    monkeypatch.setattr(qwen, "_resolve_voice", lambda engine: "matching_voice")
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)
    monkeypatch.setattr(qwen, "_make_qwen", lambda: MagicMock())

    # Sample count/rate/RMS all match the baseline entry exactly, so the
    # only thing that could stop this test completing cleanly is a
    # voice-check false positive (a spurious skip OR a spurious failure).
    result = _make_mock_synthesize_result_audible(24000)
    with patch.object(qwen, "synthesise_or_skip", return_value=result):
        try:
            qwen.test_qwen_golden_lengths_match_baseline()  # must not skip or fail
        except pytest.skip.Exception as exc:
            pytest.fail(f"must not skip when the resolved voice matches the baseline's, but skipped: {exc}")


def test_assertion_loop_tolerates_missing_voice_key_in_baseline_entry(monkeypatch) -> None:
    """A baseline entry with NO recorded `voice` key must NOT be treated as a
    mismatch — this is the `is not None` half of the voice-mismatch check's
    guard, deliberately untested by the sibling mismatch test above (which
    always seeds a recorded voice). Passes cleanly end to end (no
    AssertionError, no SKIP) with matching audio, proving the check is a
    no-op rather than a false positive when `voice` is absent. Kills the
    mutation where the set comprehension's `if e.get("voice") is not None`
    filter is dropped, which would let a bare `None` into `recorded_voices`
    and skip every voice-absent entry (#1994 review-round-2 finding M1: this
    test used to just call the function with no failure wrapper, so under
    that mutant it silently turned PASS into SKIP instead of catching it —
    pytest treats an uncaught `Skipped` from inside a test body as that test
    being skipped, not failed, so the suite stayed green either way)."""
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
    # thing that could raise (or skip) is a voice-mismatch false positive.
    result = _make_mock_synthesize_result_audible(24000)
    monkeypatch.setattr(qwen, "_make_qwen", lambda: MagicMock())

    with patch.object(qwen, "synthesise_or_skip", return_value=result):
        try:
            qwen.test_qwen_golden_lengths_match_baseline()  # must not raise or skip
        except pytest.skip.Exception as exc:
            pytest.fail(f"must not skip when the baseline entry has no recorded voice, but skipped: {exc}")


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


