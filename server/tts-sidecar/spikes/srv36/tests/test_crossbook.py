import pytest
from spikes.srv36.crossbook import evaluate_axes

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
