import numpy as np
from spikes.srv36.metrics import cosine, eer, centroid, spread_stats, coverage


def test_cosine_basic():
    assert cosine([1, 0], [1, 0]) == 1.0
    assert cosine([1, 0], [0, 1]) == 0.0
    assert cosine([0, 0], [1, 0]) == 0.0


def test_centroid_is_unit_norm_mean_direction():
    c = centroid([[1.0, 0.0], [0.0, 1.0]])
    assert abs(np.linalg.norm(c) - 1.0) < 1e-6
    assert cosine(c, [1, 1]) > 0.999  # mean direction is the 45° axis


def test_eer_separable_and_overlap():
    assert eer([0.9, 0.95], [0.1, 0.2])["eer"] == 0.0
    assert eer([0.5, 0.5], [0.5, 0.5])["eer"] >= 0.5


def test_spread_stats():
    out = spread_stats([0.90, 0.92, 0.88, 0.91])
    assert 0.88 <= out["mean"] <= 0.92 and out["std"] >= 0.0 and out["p05"] <= out["mean"]


def test_coverage():
    assert coverage([1.0, 2.0, 3.0, 0.5], 2.0) == 0.5
