import numpy as np
import pytest

speechbrain = pytest.importorskip("speechbrain")  # weights-bound → SKIP if absent


def _sine_pcm(freq, sr=16000, secs=2.0):
    t = np.linspace(0, secs, int(sr * secs), endpoint=False)
    return (np.sin(2 * np.pi * freq * t) * 8000).astype("<i2").tobytes()


def test_embed_is_unit_norm_and_192d():
    from main import SPK
    emb = SPK.embed(_sine_pcm(180), 16000)
    assert len(emb) == 192
    assert abs(float(np.linalg.norm(emb)) - 1.0) < 1e-4


def test_self_cosine_is_one():
    from main import SPK
    from spikes.srv36.metrics import cosine
    pcm = _sine_pcm(180)
    assert cosine(SPK.embed(pcm, 16000), SPK.embed(pcm, 16000)) > 0.999
