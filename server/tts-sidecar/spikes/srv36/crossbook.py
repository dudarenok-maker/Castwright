"""Pure cross-book measurement helpers for the srv-36 Phase-2 spike. numpy only."""
from __future__ import annotations
import numpy as np
from spikes.srv36.metrics import cosine, centroid


def evaluate_axes(measured: dict, thresholds: dict) -> dict:
    t = thresholds
    cross_book = (
        measured.get("g6_separation_auc", 0.0) >= t["g6_min_separation_auc"]
        and measured.get("g1_genuine_drift_stds", 1e9) <= t["g1_max_genuine_drift_stds"]
        and measured.get("g5_fp_rate", 1.0) <= t["g5_max_fp_rate"]
    )
    maturation = measured.get("g2_divergence", 0.0) >= t["g2_material_divergence"]
    per_emotion = measured.get("g3_emotion_shift", 0.0) >= t["g3_material_emotion_shift"]
    wander = (
        measured.get("g4_wander_slope", 0.0) >= t["g4_min_wander_slope"]
        and measured.get("g4_residual_fraction", 0.0) >= t["g4_min_residual_fraction"]
    )
    return {
        "cross_book": "go" if cross_book else "no-go",
        "maturation": "go" if maturation else "no-go",
        "per_emotion": "go" if per_emotion else "no-go",
        "wander": "go" if wander else "no-go",
    }
