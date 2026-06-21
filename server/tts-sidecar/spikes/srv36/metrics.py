"""Pure measurement helpers for the srv-36 stochastic-drift spike. numpy only."""
from __future__ import annotations
import numpy as np


def cosine(a, b) -> float:
    a = np.asarray(a, np.float64); b = np.asarray(b, np.float64)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(np.dot(a, b) / (na * nb)) if na and nb else 0.0


def centroid(embeddings) -> "np.ndarray":
    m = np.asarray(embeddings, np.float64).mean(axis=0)
    n = np.linalg.norm(m)
    return (m / n) if n else m


def eer(genuine, impostor) -> dict:
    g = np.asarray(genuine, np.float64); im = np.asarray(impostor, np.float64)
    cands = np.unique(np.concatenate([g, im, [g.min() - 1e-6, im.max() + 1e-6]])) \
        if g.size and im.size else np.array([0.0])
    best = {"eer": 1.0, "threshold": 0.0, "gap": 2.0}
    for thr in cands:
        far = float(np.mean(im >= thr)) if im.size else 0.0
        frr = float(np.mean(g < thr)) if g.size else 0.0
        if abs(far - frr) < best["gap"]:
            best = {"eer": (far + frr) / 2.0, "threshold": float(thr), "gap": abs(far - frr)}
    return {"eer": best["eer"], "threshold": best["threshold"]}


def spread_stats(sims) -> dict:
    a = np.asarray(sims, np.float64)
    return {"mean": float(a.mean()), "std": float(a.std()), "p05": float(np.percentile(a, 5))}


def coverage(durations, floor) -> float:
    d = np.asarray(durations, np.float64)
    return float(np.mean(d >= floor)) if d.size else 0.0
