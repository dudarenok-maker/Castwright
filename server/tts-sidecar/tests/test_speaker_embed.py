import numpy as np
import pytest


async def _noop_async(*a, **k):
    return None


def _sine_pcm(freq, sr=16000, secs=2.0):
    t = np.linspace(0, secs, int(sr * secs), endpoint=False)
    return (np.sin(2 * np.pi * freq * t) * 8000).astype("<i2").tobytes()


def test_embed_is_unit_norm_and_192d():
    pytest.importorskip("speechbrain")
    from main import SPK
    emb = SPK.embed(_sine_pcm(180), 16000)
    assert len(emb) == 192
    assert abs(float(np.linalg.norm(emb)) - 1.0) < 1e-4


def test_self_cosine_is_one():
    pytest.importorskip("speechbrain")
    from main import SPK
    from spikes.srv36.metrics import cosine
    pcm = _sine_pcm(180)
    assert cosine(SPK.embed(pcm, 16000), SPK.embed(pcm, 16000)) > 0.999


def test_embed_endpoint_raw_body(monkeypatch):
    from fastapi.testclient import TestClient
    import main
    monkeypatch.setattr(main.SPK, "embed", lambda pcm, sr: [0.0] * 192)
    monkeypatch.setattr(main.SPK, "ensure_loaded", _noop_async)
    client = TestClient(main.app)
    r = client.post("/embed", content=_sine_pcm(180), headers={"X-Sample-Rate": "16000"})
    assert r.status_code == 200
    body = r.json()
    assert body["dim"] == 192 and len(body["embedding"]) == 192
    assert body["sample_rate"] == 16000
