import pytest
import numpy as np
from spikes.srv36.crossbook import (
    evaluate_axes,
    assemble_measured,
    same_text_floor,
    crossbook_genuine_drift_stds,
    seed_divergence,
    separation_auc,
    emotion_shift,
    wander_slope,
)

THRESH = {
    "g6_min_separation_auc": 0.80, "g1_max_genuine_drift_stds": 3.0,
    "g5_max_fp_rate": 0.20, "g2_material_divergence": 0.08,
    "g3_material_emotion_shift": 0.08, "g4_min_wander_slope": 0.02,
    "g4_min_residual_fraction": 0.20,
}

def test_cross_book_go_when_separable_consistent_and_low_fp():
    measured = {"g6_separation_auc": 0.88, "g1_genuine_drift_stds": 1.5, "g5_fp_rate": 0.10}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "go"

def test_genuine_voice_wandering_kills_cross_book_regardless_of_g6():
    # same voiceUuid drifts 5 floor-stds across books → canonical would false-flag → no-go
    # even with a perfect impostor-separation AUC
    measured = {"g6_separation_auc": 0.99, "g1_genuine_drift_stds": 5.0, "g5_fp_rate": 0.10}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "no-go"

def test_high_blind_fp_kills_cross_book():
    measured = {"g6_separation_auc": 0.95, "g1_genuine_drift_stds": 1.0, "g5_fp_rate": 0.50}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "no-go"

def test_axes_are_independent():
    measured = {"g6_separation_auc": 0.88, "g1_genuine_drift_stds": 1.5, "g5_fp_rate": 0.10,
                "g4_wander_slope": 0.001, "g4_residual_fraction": 0.05}
    out = evaluate_axes(measured, THRESH)
    assert out["cross_book"] == "go" and out["wander"] == "no-go"


# Task 3: G0 — same-text content control
def test_same_text_floor_zero_for_identical():
    e = np.array([0.6, 0.8, 0.0])
    out = same_text_floor([e, e, e])
    assert out["mean"] == pytest.approx(0.0, abs=1e-9) and out["std"] == pytest.approx(0.0, abs=1e-9)


def test_same_text_floor_reports_mean_and_std():
    a = np.array([1.0, 0.0])
    b = np.array([0.0, 1.0])
    out = same_text_floor([a, a, b])   # pairwise dists: 0, 1, 1
    assert out["mean"] > 0.5 and out["std"] > 0.0


# Task 4: G1 — genuine-voice cross-book drift
def test_drift_stds_small_for_consistent_voice():
    bookA = [np.array([1.0, 0.0]), np.array([0.99, 0.01])]
    bookB = [np.array([0.98, 0.02]), np.array([1.0, 0.0])]
    # centroid distance ~0.0002; floor_std 0.01 → ~0.02 stds → consistent
    assert crossbook_genuine_drift_stds({1: bookA, 2: bookB}, floor_std=0.01) < 1.0


def test_drift_stds_large_for_wandering_voice():
    bookA = [np.array([1.0, 0.0]), np.array([1.0, 0.0])]
    bookB = [np.array([0.0, 1.0]), np.array([0.0, 1.0])]  # whole book shifted → dist 1.0
    assert crossbook_genuine_drift_stds({1: bookA, 2: bookB}, floor_std=0.01) > 50.0


def test_drift_stds_zero_floor_guarded():
    bookA = [np.array([1.0, 0.0])]
    bookB = [np.array([1.0, 0.0])]
    # zero floor_std must not divide-by-zero; identical → 0 stds
    assert crossbook_genuine_drift_stds({1: bookA, 2: bookB}, floor_std=0.0) == 0.0


# Task 5: G2 — seed divergence
def test_seed_divergence_zero_when_audition_matches_books():
    aud = np.array([1.0, 0.0])
    out = seed_divergence(aud, [np.array([1.0, 0.0]), np.array([0.99, 0.01])])
    assert out["central"] < 0.02 and out["spread"] < 0.02


def test_seed_divergence_reports_spread_across_books():
    aud = np.array([1.0, 0.0])
    out = seed_divergence(aud, [np.array([1.0, 0.0]), np.array([0.0, 1.0])])
    assert out["central"] > 0.3 and out["spread"] > 0.3


# Task 6: G6 — separation AUC
def test_separation_auc_perfect():
    assert separation_auc([0.9, 0.95, 0.92], [0.1, 0.2, 0.15]) == pytest.approx(1.0)


def test_separation_auc_all_ties_is_exactly_half():
    assert separation_auc([0.5, 0.5], [0.5, 0.5]) == pytest.approx(0.5)


def test_separation_auc_interleaved_is_near_half():
    # genuinely overlapping distributions → ~0.5, not a degenerate all-ties path
    assert 0.3 <= separation_auc([0.4, 0.6], [0.5, 0.5]) <= 0.7


# Task 7: G3 — emotion shift
def test_emotion_shift_zero_when_same():
    neutral = [np.array([1.0, 0.0]), np.array([0.99, 0.01])]
    emotional = [np.array([1.0, 0.0])]
    assert emotion_shift(neutral, emotional) < 0.02


def test_emotion_shift_positive_when_timbre_moves():
    neutral = [np.array([1.0, 0.0])]
    emotional = [np.array([0.0, 1.0])]
    assert emotion_shift(neutral, emotional) > 0.5


# Task 8: G4 — wander slope
def test_wander_slope_flat_for_stable_voice():
    assert abs(wander_slope([0.9, 0.9, 0.9, 0.9])) < 0.01


def test_wander_slope_negative_for_drifting_voice():
    assert wander_slope([0.95, 0.85, 0.75, 0.65]) < -0.05


# Task 10: report assembler
def test_assemble_measured_maps_gate_results_to_evaluator_keys():
    per_gate = {"g6": {"separation_auc": 0.88}, "g1": {"genuine_drift_stds": 1.5},
                "g5": {"fp_rate": 0.10}, "g2": {"central": 0.03},
                "g3": {"emotion_shift": 0.02}, "g4": {"wander_slope": 0.001, "residual_fraction": 0.05}}
    m = assemble_measured(per_gate)
    assert m["g6_separation_auc"] == 0.88 and m["g1_genuine_drift_stds"] == 1.5
    assert m["g5_fp_rate"] == 0.10 and m["g2_divergence"] == 0.03
    assert m["g4_wander_slope"] == 0.001 and m["g4_residual_fraction"] == 0.05


def test_assemble_measured_missing_gates_use_safe_fail_defaults():
    m = assemble_measured({})  # nothing measured yet
    # safe-fail: forces cross-book no-go (auc 0, drift 1e9, fp 1.0)
    assert m["g6_separation_auc"] == 0.0 and m["g1_genuine_drift_stds"] == 1e9 and m["g5_fp_rate"] == 1.0
