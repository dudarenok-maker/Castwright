import math, numpy as np, pytest
pytest.importorskip("speechbrain"); pytest.importorskip("torch")
from spikes.srv36.embed import embed_pcm


def _tone(sr=16000, secs=2.0, hz=140.0):
    t = np.arange(int(sr * secs)) / sr
    return (np.sin(2 * math.pi * hz * t) * 8000).astype("<i2").tobytes()


def test_embed_is_deterministic_and_unit_norm():
    a, b = embed_pcm(_tone(), 16000), embed_pcm(_tone(), 16000)
    assert a.shape == (192,)
    assert np.allclose(a, b)
    assert abs(np.linalg.norm(a) - 1.0) < 1e-4
    assert float(a @ b) > 0.999
