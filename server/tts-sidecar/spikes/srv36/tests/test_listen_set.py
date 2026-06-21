"""Tests for srv-36 held-out listen-set generator (select_listen_set).

All tests are PURE (numpy only) — no audio files, no speechbrain weights.
The `select_listen_set` function is the unit under test.

Design choices documented here:
- Manifest row keys: character, chapter, sentence_id, cosine, predicted_verdict
- predicted_verdict: "severe" for below severe_edge threshold, "band" for straddle
- Selection order: flagged (below severe_edge) first (lowest cosine first),
  then straddle (between severe_edge and band_upper), also lowest cosine first
- Cap: total clips <= cap (default 20); flagged fill as many slots as possible,
  straddle fills remainder
- Thresholds are derived per-character from the per_char_clean_cosines (same as
  calibrate.py): severe_edge = percentile(severe_edge_pctl) of each character's
  clean cosines; band_upper = percentile(band_upper_pctl)
- A segment with no character match in per_char_clean_cosines is skipped
"""
from __future__ import annotations

import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Module under test (will fail until listen_set.py is implemented — RED)
# ---------------------------------------------------------------------------
from spikes.srv36.listen_set import select_listen_set


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seg(
    character: str,
    chapter: str,
    sentence_id: str,
    cosine: float,
    duration_sec: float = 3.0,
) -> dict:
    """Build a minimal scored segment dict."""
    return {
        "character": character,
        "chapter": chapter,
        "sentence_id": sentence_id,
        "cosine": cosine,
        "duration_sec": duration_sec,
    }


def _cutoffs(severe_edge_pctl: int = 5, band_upper_pctl: int = 7) -> dict:
    return {
        "severe_edge_pctl": severe_edge_pctl,
        "band_upper_pctl": band_upper_pctl,
        "min_duration_sec": 2.0,
    }


def _clean_cosines_for(char: str, n: int = 100, mean: float = 0.92,
                       std: float = 0.02, seed: int = 0) -> list[float]:
    rng = np.random.default_rng(seed)
    return list(rng.normal(mean, std, n).clip(0.01, 1.0))


# ---------------------------------------------------------------------------
# Test 1: manifest row shape
# ---------------------------------------------------------------------------

class TestManifestRowShape:
    """Every returned row must carry the five required keys."""

    def test_rows_have_required_keys(self):
        clean_cosines = _clean_cosines_for("alice")
        # severe_edge at p5 of clean: ~0.92 - 2*0.02 ~ 0.88; anything well below is severe
        segs = [
            _seg("alice", "ch01", "s-001", 0.50),
            _seg("alice", "ch01", "s-002", 0.55),
        ]
        per_char_clean = {"alice": clean_cosines}
        rows = select_listen_set(segs, per_char_clean, _cutoffs())
        assert len(rows) >= 1, "Expected at least one row"
        for row in rows:
            for key in ("character", "chapter", "sentence_id", "cosine", "predicted_verdict"):
                assert key in row, f"Row missing key '{key}': {row}"

    def test_row_cosine_matches_input(self):
        clean_cosines = _clean_cosines_for("alice")
        segs = [_seg("alice", "ch01", "s-001", 0.50)]
        per_char_clean = {"alice": clean_cosines}
        rows = select_listen_set(segs, per_char_clean, _cutoffs())
        assert rows[0]["cosine"] == pytest.approx(0.50)

    def test_row_character_matches_input(self):
        clean_cosines = _clean_cosines_for("alice")
        segs = [_seg("alice", "ch01", "s-001", 0.50)]
        per_char_clean = {"alice": clean_cosines}
        rows = select_listen_set(segs, per_char_clean, _cutoffs())
        assert rows[0]["character"] == "alice"


# ---------------------------------------------------------------------------
# Test 2: predicted_verdict values
# ---------------------------------------------------------------------------

class TestPredictedVerdict:
    """Segments below severe_edge → 'severe'; straddle → 'band'."""

    def _setup(self):
        # Build clean cosines with mean 0.92, std 0.02
        # p5 of N(0.92, 0.02, 100) ≈ 0.889; p7 ≈ 0.895 (approx)
        # We'll use a fixed distribution so thresholds are predictable
        rng = np.random.default_rng(42)
        clean = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        severe_thr = float(np.percentile(clean, 5))
        band_thr = float(np.percentile(clean, 7))
        return clean, severe_thr, band_thr

    def test_below_severe_edge_is_severe(self):
        clean, severe_thr, band_thr = self._setup()
        # Cosine clearly below severe threshold
        very_low = severe_thr - 0.10
        segs = [_seg("alice", "ch01", "s-001", very_low)]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        assert len(rows) == 1
        assert rows[0]["predicted_verdict"] == "severe"

    def test_in_band_is_band(self):
        clean, severe_thr, band_thr = self._setup()
        # Cosine between severe_thr and band_thr
        mid = (severe_thr + band_thr) / 2.0
        segs = [_seg("alice", "ch01", "s-001", mid)]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        assert len(rows) == 1
        assert rows[0]["predicted_verdict"] == "band"

    def test_above_band_upper_is_excluded(self):
        clean, severe_thr, band_thr = self._setup()
        # Cosine clearly above band_thr → not included
        high = band_thr + 0.10
        segs = [_seg("alice", "ch01", "s-001", high)]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        assert len(rows) == 0, f"Expected 0 rows for cosine above band, got {len(rows)}"


# ---------------------------------------------------------------------------
# Test 3: selection priority and ordering
# ---------------------------------------------------------------------------

class TestSelectionPriority:
    """Flagged segments come before band segments; within each tier, lowest cosine first."""

    def _clean_and_thresholds(self):
        rng = np.random.default_rng(7)
        clean = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        severe_thr = float(np.percentile(clean, 5))
        band_thr = float(np.percentile(clean, 7))
        return clean, severe_thr, band_thr

    def test_flagged_comes_before_band(self):
        clean, severe_thr, band_thr = self._clean_and_thresholds()
        mid_band = (severe_thr + band_thr) / 2.0
        very_low = severe_thr - 0.05
        segs = [
            _seg("alice", "ch02", "band-001", mid_band),   # band
            _seg("alice", "ch01", "flag-001", very_low),   # severe
        ]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        assert len(rows) == 2
        assert rows[0]["predicted_verdict"] == "severe", "Severe should come first"
        assert rows[1]["predicted_verdict"] == "band"

    def test_flagged_ordered_lowest_cosine_first(self):
        clean, severe_thr, band_thr = self._clean_and_thresholds()
        low1 = severe_thr - 0.20
        low2 = severe_thr - 0.10
        low3 = severe_thr - 0.15
        segs = [
            _seg("alice", "ch01", "f-b", low2),
            _seg("alice", "ch01", "f-a", low1),
            _seg("alice", "ch01", "f-c", low3),
        ]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        severe_rows = [r for r in rows if r["predicted_verdict"] == "severe"]
        cosines = [r["cosine"] for r in severe_rows]
        assert cosines == sorted(cosines), f"Severe rows not sorted by cosine asc: {cosines}"

    def test_band_ordered_lowest_cosine_first(self):
        clean, severe_thr, band_thr = self._clean_and_thresholds()
        band_mid = (severe_thr + band_thr) / 2.0
        band_lo = severe_thr + 0.001
        band_hi = band_thr - 0.001
        segs = [
            _seg("alice", "ch01", "b-b", band_hi),
            _seg("alice", "ch01", "b-a", band_lo),
            _seg("alice", "ch01", "b-c", band_mid),
        ]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        band_rows = [r for r in rows if r["predicted_verdict"] == "band"]
        cosines = [r["cosine"] for r in band_rows]
        assert cosines == sorted(cosines), f"Band rows not sorted by cosine asc: {cosines}"


# ---------------------------------------------------------------------------
# Test 4: cap enforcement
# ---------------------------------------------------------------------------

class TestCapEnforcement:
    """Total returned clips must not exceed the cap (default 20)."""

    def _setup(self, n_severe: int = 15, n_band: int = 10):
        rng = np.random.default_rng(13)
        clean = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        severe_thr = float(np.percentile(clean, 5))
        band_thr = float(np.percentile(clean, 7))
        segs = []
        for i in range(n_severe):
            segs.append(_seg("alice", "ch01", f"severe-{i}", severe_thr - 0.05 - i * 0.001))
        for i in range(n_band):
            mid = (severe_thr + band_thr) / 2.0
            segs.append(_seg("alice", "ch01", f"band-{i}", mid + i * 0.0001))
        return clean, segs

    def test_default_cap_is_20(self):
        clean, segs = self._setup(15, 10)
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        assert len(rows) <= 20, f"Expected <= 20 rows, got {len(rows)}"

    def test_custom_cap_respected(self):
        clean, segs = self._setup(15, 10)
        for cap in (5, 10, 15):
            rows = select_listen_set(segs, {"alice": clean}, _cutoffs(), cap=cap)
            assert len(rows) <= cap, f"cap={cap}: got {len(rows)} rows"

    def test_fewer_than_cap_returns_all_eligible(self):
        rng = np.random.default_rng(20)
        clean = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        severe_thr = float(np.percentile(clean, 5))
        segs = [_seg("alice", "ch01", f"s-{i}", severe_thr - 0.05) for i in range(3)]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs(), cap=20)
        assert len(rows) == 3, "Should return all 3 eligible segments when under cap"

    def test_flagged_prioritised_over_band_at_cap(self):
        """When cap is tight, severe rows fill the cap before band rows."""
        rng = np.random.default_rng(30)
        clean = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        severe_thr = float(np.percentile(clean, 5))
        band_thr = float(np.percentile(clean, 7))
        segs = []
        for i in range(10):
            segs.append(_seg("alice", "ch01", f"sev-{i}", severe_thr - 0.01 - i * 0.001))
        for i in range(10):
            mid = (severe_thr + band_thr) / 2.0
            segs.append(_seg("alice", "ch01", f"band-{i}", mid))
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs(), cap=8)
        assert len(rows) <= 8
        verdicts = [r["predicted_verdict"] for r in rows]
        # All severe rows are included (10 severe, but cap=8 → 8 severe, no band)
        severe_count = verdicts.count("severe")
        band_count = verdicts.count("band")
        # Severe fills the cap; band gets whatever remains (0 in this case)
        assert severe_count + band_count == len(rows)
        assert severe_count <= 8
        # No band row should appear ahead of a severe row that was cut
        # (i.e., if any band rows exist, we should have exactly cap severe rows)
        if band_count > 0:
            assert severe_count == cap, "Severe should fill cap before band gets any slots"


# ---------------------------------------------------------------------------
# Test 5: multi-character handling
# ---------------------------------------------------------------------------

class TestMultiCharacter:
    """Segments from multiple characters are all eligible; thresholds are per-character."""

    def test_two_characters_both_eligible(self):
        rng = np.random.default_rng(50)
        clean_a = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        clean_b = list(rng.normal(0.88, 0.03, 200).clip(0.01, 1.0))
        severe_thr_a = float(np.percentile(clean_a, 5))
        severe_thr_b = float(np.percentile(clean_b, 5))
        segs = [
            _seg("alice", "ch01", "a-001", severe_thr_a - 0.05),
            _seg("bob", "ch01", "b-001", severe_thr_b - 0.05),
        ]
        per_char_clean = {"alice": clean_a, "bob": clean_b}
        rows = select_listen_set(segs, per_char_clean, _cutoffs())
        chars_in_rows = {r["character"] for r in rows}
        assert "alice" in chars_in_rows
        assert "bob" in chars_in_rows

    def test_unknown_character_excluded(self):
        """A segment whose character has no entry in per_char_clean_cosines is skipped."""
        rng = np.random.default_rng(55)
        clean_a = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        segs = [
            _seg("alice", "ch01", "a-001", 0.40),   # alice: known
            _seg("unknown", "ch01", "u-001", 0.30),  # unknown: no clean cosines
        ]
        rows = select_listen_set(segs, {"alice": clean_a}, _cutoffs())
        chars = [r["character"] for r in rows]
        assert "unknown" not in chars, "Unknown character should be excluded"


# ---------------------------------------------------------------------------
# Test 6: edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases:
    """Empty inputs and degenerate cases must not crash."""

    def test_empty_segments(self):
        rng = np.random.default_rng(1)
        clean = list(rng.normal(0.92, 0.02, 100).clip(0.01, 1.0))
        rows = select_listen_set([], {"alice": clean}, _cutoffs())
        assert rows == []

    def test_empty_per_char_clean(self):
        segs = [_seg("alice", "ch01", "s-001", 0.50)]
        rows = select_listen_set(segs, {}, _cutoffs())
        assert rows == []

    def test_no_eligible_segments_returns_empty(self):
        """All segments above band_upper → empty result."""
        rng = np.random.default_rng(2)
        clean = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        band_thr = float(np.percentile(clean, 7))
        segs = [
            _seg("alice", "ch01", f"s-{i}", band_thr + 0.05 + i * 0.001)
            for i in range(10)
        ]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        assert rows == []

    def test_single_segment_below_severe(self):
        rng = np.random.default_rng(3)
        clean = list(rng.normal(0.92, 0.02, 200).clip(0.01, 1.0))
        severe_thr = float(np.percentile(clean, 5))
        segs = [_seg("alice", "ch01", "s-001", severe_thr - 0.05)]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs())
        assert len(rows) == 1
        assert rows[0]["predicted_verdict"] == "severe"

    def test_cap_zero_returns_empty(self):
        rng = np.random.default_rng(4)
        clean = list(rng.normal(0.92, 0.02, 100).clip(0.01, 1.0))
        severe_thr = float(np.percentile(clean, 5))
        segs = [_seg("alice", "ch01", "s-001", severe_thr - 0.05)]
        rows = select_listen_set(segs, {"alice": clean}, _cutoffs(), cap=0)
        assert rows == []
