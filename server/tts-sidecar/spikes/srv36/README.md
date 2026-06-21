# srv-36 Phase-0 Stochastic Spike

## Setup

Install speechbrain:

```bash
pip install speechbrain
```

Note: The fixture's designed Qwen/Coqui voices must be in the workspace for testing.

## ECAPA-TDNN Embedding Wrapper

The `embed.py` module provides:

- `load_encoder()` — cached loader for speechbrain ECAPA-TDNN encoder
- `embed_pcm(pcm: bytes, sample_rate: int) -> np.ndarray` — embeds PCM audio into a 192-dim L2-normalised vector

## Pipeline

1. **Phase-0 (this spike):** Over-generation via Task 8; analysis via Task 7
2. **F4 listening step:** Manual acceptance on fixture chapters

## Test

```bash
cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_embed.py -v
```

Expected: PASS (if speechbrain installed) or SKIP (if not).
