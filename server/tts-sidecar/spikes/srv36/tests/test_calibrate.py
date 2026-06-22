"""Tests for the srv-36 calibration harness (cutoff fitting).

All tests use PURE numpy — no speechbrain/weights needed. The `fit_cutoffs`
function is designed to be testable on synthetic distributions.

Design choices documented here:
- severe_edge_pctl: the percentile on the CLEAN distribution below which a
  cosine is flagged "severe" — chosen as the percentile that minimises the
  operating-point error rate (FAR+FRR)/2 at the percentile threshold.
  Candidate scan: percentiles 1..13 (capped so band_upper stays <= 15).
  Fallback p=5 when no labelled drift or no labelled clean.
- band_upper_pctl: severe_edge_pctl + 2 (always strictly above, <= 15, since
  the scan cap guarantees severe_edge_pctl <= 13).
- min_duration_sec: the shortest clip length at which cosine variance (std of
  cosine-to-centroid) drops below LEN_STD_THRESHOLD (= aggregates.LEN_STD_OK)
  across the labelled clips. Derived from binning labelled clips by duration and
  measuring std-of-cosines in each bin. The [0,1) bin's lower edge is 0.0 —
  meaningless as a floor — so DEFAULT_FLOOR_SEC is returned when that bin clears.
"""
from __future__ import annotations
import numpy as np
import pytest

# ---------------------------------------------------------------------------
# Module under test — must exist for the test to pass (red until implemented)
# ---------------------------------------------------------------------------
from spikes.srv36.calibrate import fit_cutoffs, DEFAULT_FLOOR_SEC, LEN_STD_THRESHOLD


# ---------------------------------------------------------------------------
# Helpers to build synthetic distributions
# ---------------------------------------------------------------------------

def _make_unit_vec(dim: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float64)
    return v / np.linalg.norm(v)


def _perturb(base: np.ndarray, noise: float, seed: int) -> np.ndarray:
    """Return a unit-normed perturbation of `base` with given noise magnitude."""
    rng = np.random.default_rng(seed)
    v = base + noise * rng.standard_normal(base.shape)
    v = v.astype(np.float64)
    return v / np.linalg.norm(v)


# ---------------------------------------------------------------------------
# Labelled-clip helper
# ---------------------------------------------------------------------------

def _make_labelled_clip(cosine_to_centroid: float, duration_sec: float,
                        sentence_id: str, label: str) -> dict:
    """Construct a labelled clip dict matching the calibrate.py contract."""
    return {
        "sentence_id": sentence_id,
        "cosine": cosine_to_centroid,
        "duration_sec": duration_sec,
        "label": label,   # "clean" | "drift"
    }


# ---------------------------------------------------------------------------
# Test 1: fit_cutoffs returns the percentile that best separates labelled drift
# ---------------------------------------------------------------------------

class TestFitCutoffsSeparation:
    """Core contract: the returned severe_edge_pctl must be the one that best
    separates labelled drift from labelled clean via operating-point EER scan."""

    def _build_inputs(self):
        rng = np.random.default_rng(42)
        # Clearly separated: clean around 0.95, drift around 0.50
        char_clean = {"alice": list(rng.normal(0.95, 0.02, 120).clip(0.01, 1.0))}
        labelled = []
        for i in range(30):
            labelled.append(_make_labelled_clip(
                cosine_to_centroid=float(rng.normal(0.94, 0.02)),
                duration_sec=float(rng.uniform(2.5, 6.0)),
                sentence_id=f"s-clean-{i}",
                label="clean",
            ))
        for i in range(20):
            labelled.append(_make_labelled_clip(
                cosine_to_centroid=float(rng.normal(0.50, 0.06)),
                duration_sec=float(rng.uniform(2.5, 6.0)),
                sentence_id=f"s-drift-{i}",
                label="drift",
            ))
        return char_clean, labelled

    def test_returns_required_keys(self):
        char_clean, labelled = self._build_inputs()
        result = fit_cutoffs(char_clean, labelled)
        for key in ("severe_edge_pctl", "band_upper_pctl", "min_duration_sec", "N", "K"):
            assert key in result, f"Missing key: {key}"

    def test_severe_pctl_is_int_in_valid_range(self):
        char_clean, labelled = self._build_inputs()
        result = fit_cutoffs(char_clean, labelled)
        p = result["severe_edge_pctl"]
        assert isinstance(p, int)
        assert 1 <= p <= 13, f"severe_edge_pctl={p} out of [1,13]"

    def test_band_upper_above_severe_edge(self):
        char_clean, labelled = self._build_inputs()
        result = fit_cutoffs(char_clean, labelled)
        assert result["band_upper_pctl"] > result["severe_edge_pctl"]

    def test_band_upper_at_most_15(self):
        char_clean, labelled = self._build_inputs()
        result = fit_cutoffs(char_clean, labelled)
        assert result["band_upper_pctl"] <= 15

    def test_n_counts_total_labelled_clips(self):
        char_clean, labelled = self._build_inputs()
        result = fit_cutoffs(char_clean, labelled)
        assert result["N"] == len(labelled)

    def test_k_counts_total_clean_cosines(self):
        char_clean, labelled = self._build_inputs()
        result = fit_cutoffs(char_clean, labelled)
        total_clean = sum(len(v) for v in char_clean.values())
        assert result["K"] == total_clean

    def test_severe_pctl_separates_with_low_error_rate(self):
        """The chosen percentile must achieve an operating-point error rate <=0.20
        on clearly separated data AND beat the naive p=5 fallback."""
        rng = np.random.default_rng(99)
        # Clearly separated: clean near 0.95, drift near 0.48
        char_clean = {"bob": list(rng.normal(0.95, 0.015, 200).clip(0.01, 1.0))}
        labelled = []
        for i in range(40):
            labelled.append(_make_labelled_clip(
                cosine_to_centroid=float(rng.normal(0.94, 0.015)),
                duration_sec=float(rng.uniform(2.0, 7.0)),
                sentence_id=f"sc-{i}", label="clean",
            ))
        for i in range(30):
            labelled.append(_make_labelled_clip(
                cosine_to_centroid=float(rng.normal(0.48, 0.07)),
                duration_sec=float(rng.uniform(2.0, 7.0)),
                sentence_id=f"sd-{i}", label="drift",
            ))
        result = fit_cutoffs(char_clean, labelled)
        chosen_p = result["severe_edge_pctl"]

        all_clean_cosines = np.asarray(char_clean["bob"], np.float64)
        lab_clean_vals = np.asarray(
            [c["cosine"] for c in labelled if c["label"] == "clean"], np.float64)
        lab_drift_vals = np.asarray(
            [c["cosine"] for c in labelled if c["label"] == "drift"], np.float64)

        # Operating-point error rate at the chosen percentile
        thr = float(np.percentile(all_clean_cosines, chosen_p))
        far = float(np.mean(lab_drift_vals >= thr))
        frr = float(np.mean(lab_clean_vals < thr))
        op_err_chosen = (far + frr) / 2.0
        assert op_err_chosen <= 0.20, (
            f"Chosen p={chosen_p} yields op_err={op_err_chosen:.3f} > 0.20 on well-separated data"
        )

        # Must also beat the naive p=5 fallback (or tie at best)
        thr5 = float(np.percentile(all_clean_cosines, 5))
        far5 = float(np.mean(lab_drift_vals >= thr5))
        frr5 = float(np.mean(lab_clean_vals < thr5))
        op_err_p5 = (far5 + frr5) / 2.0
        assert op_err_chosen <= op_err_p5 + 1e-9, (
            f"Chosen p={chosen_p} (err={op_err_chosen:.3f}) is worse than naive p=5 (err={op_err_p5:.3f})"
        )


class TestFitCutoffsHardToSeparate:
    """When distributions overlap, fit_cutoffs still picks the best available
    percentile and doesn't crash."""

    def test_overlapping_distributions_picks_a_percentile(self):
        rng = np.random.default_rng(7)
        # Heavily overlapping: nearly impossible to separate
        char_clean = {"carol": list(rng.normal(0.80, 0.10, 100).clip(0.01, 0.999))}
        labelled = []
        for i in range(20):
            labelled.append(_make_labelled_clip(
                cosine_to_centroid=float(rng.normal(0.78, 0.09)),
                duration_sec=float(rng.uniform(2.5, 5.0)),
                sentence_id=f"sc-{i}", label="clean",
            ))
        for i in range(15):
            labelled.append(_make_labelled_clip(
                cosine_to_centroid=float(rng.normal(0.72, 0.10)),
                duration_sec=float(rng.uniform(2.5, 5.0)),
                sentence_id=f"sd-{i}", label="drift",
            ))
        result = fit_cutoffs(char_clean, labelled)
        assert "severe_edge_pctl" in result
        assert isinstance(result["severe_edge_pctl"], int)
        assert 1 <= result["severe_edge_pctl"] <= 13


class TestFitCutoffsEmptyOrMissingLabels:
    """Edge: no drift labels, or no clean labels — must not crash."""

    def test_no_drift_labels_falls_back_to_default_pct(self):
        rng = np.random.default_rng(3)
        char_clean = {"dave": list(rng.normal(0.92, 0.02, 80).clip(0.01, 1.0))}
        labelled = [
            _make_labelled_clip(float(rng.normal(0.91, 0.02)), float(rng.uniform(2,6)),
                                f"sc-{i}", "clean")
            for i in range(20)
        ]
        result = fit_cutoffs(char_clean, labelled)
        assert isinstance(result["severe_edge_pctl"], int)

    def test_no_clean_labels_falls_back_to_default_pct(self):
        rng = np.random.default_rng(5)
        char_clean = {"eve": list(rng.normal(0.91, 0.02, 80).clip(0.01, 1.0))}
        labelled = [
            _make_labelled_clip(float(rng.normal(0.55, 0.05)), float(rng.uniform(2,6)),
                                f"sd-{i}", "drift")
            for i in range(20)
        ]
        result = fit_cutoffs(char_clean, labelled)
        assert isinstance(result["severe_edge_pctl"], int)

    def test_empty_labelled_uses_defaults(self):
        rng = np.random.default_rng(1)
        char_clean = {"frank": list(rng.normal(0.93, 0.02, 60).clip(0.01, 1.0))}
        result = fit_cutoffs(char_clean, [])
        assert isinstance(result["severe_edge_pctl"], int)
        assert result["N"] == 0


# ---------------------------------------------------------------------------
# Test 2: min_duration_sec derived from cosine-variance-vs-clip-length
# ---------------------------------------------------------------------------

class TestMinDurationDerivation:
    """min_duration_sec must come from cosine-variance-vs-clip-length on the
    labelled clips, NOT be a hard-coded constant."""

    def test_short_clips_yield_higher_min_duration(self):
        """When labelled clips have high cosine variance at short durations and
        low variance at longer durations, min_duration_sec should reflect that."""
        rng = np.random.default_rng(21)
        # Simulate: at < 1.5s the cosine is noisy; at >= 2.5s it stabilises
        char_clean = {"greta": list(rng.normal(0.93, 0.02, 100).clip(0.01, 1.0))}

        labelled = []
        # Short clips: high variance in cosine (std >> LEN_STD_THRESHOLD)
        for i in range(30):
            dur = float(rng.uniform(0.5, 1.4))
            cos = float(rng.normal(0.80, 0.12))  # high variance, noisy
            labelled.append(_make_labelled_clip(cos, dur, f"short-{i}", "clean"))

        # Long clips: low variance (std << LEN_STD_THRESHOLD)
        for i in range(30):
            dur = float(rng.uniform(2.5, 6.0))
            cos = float(rng.normal(0.93, 0.015))  # low variance
            labelled.append(_make_labelled_clip(cos, dur, f"long-{i}", "clean"))

        result = fit_cutoffs(char_clean, labelled)
        # Bin [2,3) should stabilise first (std ~0.015 < LEN_STD_THRESHOLD=0.05)
        assert result["min_duration_sec"] == 2.0, (
            f"Expected 2.0 (first stable bin lower edge), got {result['min_duration_sec']}"
        )

    def test_all_long_clips_exact_floor(self):
        """When all labelled clips are in the [3,∞) bin with low variance,
        min_duration_sec must equal exactly 3.0."""
        rng = np.random.default_rng(33)
        char_clean = {"hiro": list(rng.normal(0.94, 0.015, 100).clip(0.01, 1.0))}
        labelled = []
        for i in range(40):
            dur = float(rng.uniform(3.1, 8.0))
            cos = float(rng.normal(0.94, 0.010))   # very low variance in [3,∞)
            labelled.append(_make_labelled_clip(cos, dur, f"sl-{i}", "clean"))
        result = fit_cutoffs(char_clean, labelled)
        # [3,∞) bin clears threshold → lower edge = 3.0
        assert result["min_duration_sec"] == 3.0, (
            f"Expected 3.0 for all-[3,∞) stable clips, got {result['min_duration_sec']}"
        )

    def test_min_duration_is_float(self):
        rng = np.random.default_rng(44)
        char_clean = {"iris": list(rng.normal(0.92, 0.02, 80).clip(0.01, 1.0))}
        labelled = [
            _make_labelled_clip(float(rng.normal(0.92, 0.02)), float(rng.uniform(1.0, 5.0)),
                                f"sm-{i}", "clean")
            for i in range(25)
        ]
        result = fit_cutoffs(char_clean, labelled)
        assert isinstance(result["min_duration_sec"], float)

    def test_zero_bin_clears_returns_default_floor(self):
        """When the [0,1) bin has very low variance and clears LEN_STD_THRESHOLD,
        DEFAULT_FLOOR_SEC must be returned (0.0 is a meaningless floor)."""
        rng = np.random.default_rng(77)
        char_clean = {"leo": list(rng.normal(0.92, 0.01, 60).clip(0.01, 1.0))}
        labelled = [
            _make_labelled_clip(float(rng.normal(0.92, 0.001)), float(rng.uniform(0.1, 0.9)),
                                f"tiny-{i}", "clean")
            for i in range(30)
        ]
        result = fit_cutoffs(char_clean, labelled)
        assert result["min_duration_sec"] == DEFAULT_FLOOR_SEC, (
            f"[0,1) bin clearing threshold should return DEFAULT_FLOOR_SEC={DEFAULT_FLOOR_SEC}, "
            f"got {result['min_duration_sec']}"
        )


# ---------------------------------------------------------------------------
# Test 3: sentence_id stability (Phase-0 fix)
# ---------------------------------------------------------------------------

class TestSentenceIdKeying:
    """Calibrate must key on sentenceIds (in labelled clips), NOT timestamps.
    The clip dict carries 'sentence_id' — the function must not crash when
    sentence_ids are provided instead of start/end timestamps."""

    def test_accepts_sentence_id_clips(self):
        rng = np.random.default_rng(55)
        char_clean = {"jay": list(rng.normal(0.93, 0.02, 80).clip(0.01, 1.0))}
        labelled = [
            {
                "sentence_id": f"sent-{i:04d}",
                "cosine": float(rng.normal(0.92, 0.02)),
                "duration_sec": float(rng.uniform(2.0, 5.0)),
                "label": "clean" if i < 15 else "drift",
            }
            for i in range(20)
        ]
        # Must not raise — sentence_id is a valid key
        result = fit_cutoffs(char_clean, labelled)
        assert result["N"] == 20

    def test_no_timestamp_dependency(self):
        """Clips without start_sec/end_sec fields must work fine."""
        rng = np.random.default_rng(66)
        char_clean = {"kim": list(rng.normal(0.91, 0.02, 70).clip(0.01, 1.0))}
        labelled = []
        for i in range(12):
            clip = {
                "sentence_id": f"s{i}",
                "cosine": float(rng.normal(0.90, 0.02)),
                "duration_sec": float(rng.uniform(2.0, 4.0)),
                "label": "clean",
            }
            # Deliberately NO start_sec / end_sec
            labelled.append(clip)
        result = fit_cutoffs(char_clean, labelled)
        assert isinstance(result, dict)


# ---------------------------------------------------------------------------
# Test 4: band_upper boundary invariant (I4 fix)
# ---------------------------------------------------------------------------

class TestBandUpperBoundary:
    """band_upper_pctl must always be strictly above severe_edge_pctl and <= 15,
    even when severe_edge_pctl is at the top of the scan range (13)."""

    def _force_high_severe(self):
        """Build inputs where the scan picks p=13 (very low threshold tolerance)."""
        rng = np.random.default_rng(88)
        # Clean pool tightly clustered near 1.0 — p=13 threshold still very high
        # Drift just slightly below clean so high percentiles still separate best
        char_clean = {"mia": list(rng.normal(0.990, 0.003, 300).clip(0.80, 1.0))}
        labelled = []
        for i in range(40):
            labelled.append(_make_labelled_clip(
                cosine_to_centroid=float(rng.normal(0.989, 0.002)),
                duration_sec=2.5,
                sentence_id=f"sc-{i}", label="clean",
            ))
        for i in range(30):
            labelled.append(_make_labelled_clip(
                cosine_to_centroid=float(rng.normal(0.970, 0.005)),
                duration_sec=2.5,
                sentence_id=f"sd-{i}", label="drift",
            ))
        return char_clean, labelled

    def test_band_upper_always_strictly_above_severe(self):
        char_clean, labelled = self._force_high_severe()
        result = fit_cutoffs(char_clean, labelled)
        assert result["band_upper_pctl"] > result["severe_edge_pctl"], (
            f"band_upper={result['band_upper_pctl']} must be > severe={result['severe_edge_pctl']}"
        )

    def test_band_upper_never_exceeds_15(self):
        char_clean, labelled = self._force_high_severe()
        result = fit_cutoffs(char_clean, labelled)
        assert result["band_upper_pctl"] <= 15, (
            f"band_upper={result['band_upper_pctl']} exceeds max 15"
        )

    def test_severe_pctl_capped_at_13(self):
        """The scan cap at 13 means severe_edge_pctl is always <= 13."""
        char_clean, labelled = self._force_high_severe()
        result = fit_cutoffs(char_clean, labelled)
        assert result["severe_edge_pctl"] <= 13, (
            f"severe_edge_pctl={result['severe_edge_pctl']} exceeds scan cap of 13"
        )
