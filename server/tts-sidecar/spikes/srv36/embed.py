"""ECAPA-TDNN embedding wrapper for the srv-36 Phase-0 spike (throwaway)."""
from __future__ import annotations
import functools
import numpy as np

TARGET_SR = 16000


@functools.lru_cache(maxsize=1)
def load_encoder():
    from speechbrain.inference.speaker import EncoderClassifier
    return EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb", run_opts={"device": "cpu"})


def embed_pcm(pcm: bytes, sample_rate: int) -> "np.ndarray":
    import torch, torchaudio
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    t = torch.from_numpy(audio).unsqueeze(0)
    if sample_rate != TARGET_SR:
        t = torchaudio.functional.resample(t, sample_rate, TARGET_SR)
    enc = load_encoder()
    with torch.no_grad():
        emb = enc.encode_batch(t).squeeze().cpu().numpy().astype(np.float32)
    norm = float(np.linalg.norm(emb))
    return emb / norm if norm > 0 else emb
