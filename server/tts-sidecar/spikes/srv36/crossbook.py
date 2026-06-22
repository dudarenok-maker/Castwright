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


def same_text_floor(same_text_embeddings) -> dict:
    embs = [np.asarray(e, np.float64) for e in same_text_embeddings]
    if len(embs) < 2:
        return {"mean": 0.0, "std": 0.0}
    dists = [1.0 - cosine(embs[i], embs[j])
             for i in range(len(embs)) for j in range(i + 1, len(embs))]
    return {"mean": float(np.mean(dists)), "std": float(np.std(dists))}


def crossbook_genuine_drift_stds(per_book_clean_embeddings: dict, floor_std: float) -> float:
    book_centroids = [centroid(embs) for embs in per_book_clean_embeddings.values() if len(embs)]
    if len(book_centroids) < 2:
        return 0.0
    dists = [1.0 - cosine(book_centroids[i], book_centroids[j])
             for i in range(len(book_centroids)) for j in range(i + 1, len(book_centroids))]
    mean_dist = float(np.mean(dists))
    if floor_std <= 0.0:
        return 0.0 if mean_dist == 0.0 else float("inf")
    return mean_dist / floor_std


def seed_divergence(audition_centroid, per_book_centroids) -> dict:
    aud = np.asarray(audition_centroid, np.float64)
    divs = [1.0 - cosine(aud, np.asarray(c, np.float64)) for c in per_book_centroids]
    if not divs:
        return {"central": 0.0, "spread": 0.0}
    return {"central": float(np.mean(divs)), "spread": float(np.std(divs))}


def separation_auc(genuine, impostor) -> float:
    g = np.asarray(genuine, np.float64)
    im = np.asarray(impostor, np.float64)
    if not g.size or not im.size:
        return 0.5
    wins = sum(float(np.sum(gi > im)) + 0.5 * float(np.sum(gi == im)) for gi in g)
    return float(wins / (g.size * im.size))


def emotion_shift(neutral_embeddings, emotional_embeddings) -> float:
    if not len(neutral_embeddings) or not len(emotional_embeddings):
        return 0.0
    return float(1.0 - cosine(centroid(neutral_embeddings), centroid(emotional_embeddings)))


def wander_slope(cosines_in_render_order) -> float:
    y = np.asarray(cosines_in_render_order, np.float64)
    if y.size < 2:
        return 0.0
    x = np.arange(y.size, dtype=np.float64)
    return float(np.polyfit(x, y, 1)[0])  # slope
