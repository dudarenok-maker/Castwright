# srv-36 Phase 0 — Residual-Value Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a throwaway measurement harness that answers, on real TTS output, whether an ECAPA speaker-embedding check can flag *same-config* render defects (near-miss wrong preset, garble, and — optionally — silent fallback) that the existing config-drift detector is blind to — and emit a committed `{go|no-go}` recommendation that gates whether srv-36 Phase 1 is ever built.

**Architecture:** A self-contained Python **package** at `server/tts-sidecar/spikes/srv36/`, run in the existing sidecar venv (which already has torch + the TTS engines; we add `speechbrain`). Pure helpers (cosine, EER, residual-value-by-tier, PCM injection transforms, coverage, the go/no-go decision) are TDD'd. Experiment *drivers* (E1–E3) render the canonical fixture's real lines on a GPU box, inject defects **in code**, feed real embeddings into the pure aggregators, and write `eN.json`. A final synthesizer reads the result files and produces `FINDINGS.md`. **No production code, no settings, no events, no sidecar engine — throwaway research.**

**Tech Stack:** Python 3.11/3.12, pytest, numpy, SpeechBrain ECAPA-TDNN (`spkrec-ecapa-voxceleb`), the existing sidecar Kokoro engine.

## Global Constraints

- **Throwaway/committed-for-reproducibility, NOT production.** No changes to `main.py`, no new endpoint, no config keys, no `segments.json` changes. Everything under `server/tts-sidecar/spikes/srv36/`.
- **Verified engine API (do not deviate):** `main.py:1934` exposes `ENGINES: dict[str, Engine]`. The synth method is `Engine.synthesize(self, model: str, voice: str, text: str) -> SynthResult` (`main.py:452/947`). `SynthResult` (`main.py:358`) has `.pcm: bytes` (mono int16-LE) and `.sample_rate: int`. For Kokoro, `model` is `"v1"`. **Always read `pcm`/`sample_rate` off the result — never assume 24000, never read `sample_rate` off the engine.** `import main` is side-effect-safe (no port bind, lazy model load — verified), but set `os.environ.setdefault("PRELOAD_COQUI","0")`/`setdefault("PRELOAD_KOKORO","0")` before importing it anyway.
- **Kokoro-only spine.** Kokoro is deterministic ONNX → reproducible. The go/no-go uses only Kokoro-renderable, **in-code-scripted** defects. **Qwen→Kokoro fallback and E4 emotion are OPTIONAL on-box enrichment** (need designed Qwen voices that may be absent); they are skipped-if-absent and **never** affect the recommendation.
- **Verified injection reality (spec §2.0):** no seed surface; Kokoro never stochastically glitches. The deterministically producible same-config defects used for the gate are: **(subtle)** same-gender near-miss preset (render a character's line with a *different female* Kokoro voice than its reference); **(gross)** distant preset (female→male) and **constructed garble** (post-synth PCM corruption). **Voice bleed is observational-only, never the gate.**
- **The gate is judged on the SUBTLE tier** (spec §2.1). A high pooled flag-rate carried by the gross tier does NOT clear the gate. Every residual-value number is reported per tier. **`aggregate_e1` errors (not silently no-goes) if the subtle list is empty** — an empty gate input is a harness bug, not a verdict.
- **Calibration anchor is the MEASURED in-domain EER, never VoxCeleb 0.9%** (spec §2.1/R2).
- **Data sources (real, committed):** voices from `samples/the-coalfall-commission/.audiobook/cast.json`; lines from a committed hand-authored `spike_lines.json` (ground-truth character→line from `server/src/__fixtures__/the-coalfall-commission.md`). **No regex attribution** — the fragile parser is dropped.
- **Recommendation field is exactly one of `{go, no-go}`** (spec §2.2) — no "descope."
- **Tests run via direct pytest invocation**, NOT `npm run test:sidecar` (verified: `pytest.ini testpaths = tests`, `run-tests.ps1` only collects `server/tts-sidecar/tests/`, so the spike dir is not on the gate path — by design, it's throwaway). Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv36/tests -v`. Model-dependent tests SKIP+exit-0 when weights/venv are absent.
- All audio is mono int16-LE PCM; ECAPA wants 16 kHz float — resample at embed time via `torchaudio.functional.resample` (present + pinned; this is NOT `torchaudio.load`, so no FFmpeg/codec dependency).

---

## File Structure

`srv36` is a valid Python package (no hyphen — `python -m spikes.srv36.run_e1` works). Modules import as `spikes.srv36.X`.

| File | Responsibility |
|---|---|
| `server/tts-sidecar/spikes/__init__.py`, `spikes/srv36/__init__.py`, `spikes/srv36/tests/__init__.py` | package markers |
| `server/tts-sidecar/spikes/srv36/README.md` | how to run on a GPU box; what each artifact means; optional Qwen steps |
| `server/tts-sidecar/spikes/srv36/spike_lines.json` | committed ground-truth `{character: [line, ...]}` from the fixture |
| `server/tts-sidecar/spikes/srv36/embed.py` | ECAPA load + `embed_pcm(pcm, sr) -> np.ndarray` (192-dim, L2-normalised) |
| `server/tts-sidecar/spikes/srv36/metrics.py` | PURE: `cosine`, `eer`, `intra_speaker_spread`, `residual_value_by_tier`, `coverage` |
| `server/tts-sidecar/spikes/srv36/inject.py` | PURE PCM transforms: `truncate`, `clip`, `reverse_span`, `splice` |
| `server/tts-sidecar/spikes/srv36/cast_data.py` | PURE loaders: `load_cast_voices()`, `load_lines()`, `near_miss_voice()` |
| `server/tts-sidecar/spikes/srv36/render.py` | on-box: `render_clip(engine, model, voice, text) -> (pcm, sr)`; `build_clips()` |
| `server/tts-sidecar/spikes/srv36/run_e1.py` | E1 residual-value: pure `aggregate_e1` + on-box driver → `results/e1.json` |
| `server/tts-sidecar/spikes/srv36/run_e2.py` | E2 separability + in-domain EER: pure `aggregate_e2` + driver → `results/e2.json` |
| `server/tts-sidecar/spikes/srv36/run_e3.py` | E3 clip-length + coverage: pure `aggregate_e3` + driver → `results/e3.json` |
| `server/tts-sidecar/spikes/srv36/run_e4.py` | E4 emotion shift (OPTIONAL): pure `aggregate_e4` + driver → `results/e4.json` |
| `server/tts-sidecar/spikes/srv36/synthesize.py` | PURE `decide(e1,e2,e3,e4) -> {recommendation, reasons}` + writes `FINDINGS.md` |
| `server/tts-sidecar/spikes/srv36/tests/*.py` | pytest for embed / metrics / inject / cast_data / aggregates |
| `server/tts-sidecar/spikes/srv36/results/.gitignore` | ignores `clips/`, `clips_manifest.json` (large PCM) |
| `server/tts-sidecar/spikes/srv36/FINDINGS.md` | the committed deliverable (go/no-go + measured numbers) |

**Tooling:** `PY="server/tts-sidecar/.venv/Scripts/python.exe"`. Pure-helper tests run under any Python with numpy/pytest. Run pytest with the sidecar dir as rootdir so `import main` and `import spikes.srv36.*` resolve: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests -v`.

---

### Task 1: Package scaffold + ECAPA embed wrapper

**Files:**
- Create: `server/tts-sidecar/spikes/__init__.py` (empty), `spikes/srv36/__init__.py` (empty), `spikes/srv36/tests/__init__.py` (empty)
- Create: `server/tts-sidecar/spikes/srv36/results/.gitignore`
- Create: `server/tts-sidecar/spikes/srv36/embed.py`
- Create: `server/tts-sidecar/spikes/srv36/tests/conftest.py`
- Create: `server/tts-sidecar/spikes/srv36/tests/test_embed.py`
- Create: `server/tts-sidecar/spikes/srv36/README.md`

**Interfaces:**
- Produces: `embed_pcm(pcm: bytes, sample_rate: int) -> np.ndarray` (192-dim float32, L2-normalised); `load_encoder()` (cached). Consumed by every `run_eN.py`.

- [ ] **Step 1: Write `.gitignore` and the embed wrapper**

`server/tts-sidecar/spikes/srv36/results/.gitignore`:
```
clips/
clips_manifest.json
```

```python
# server/tts-sidecar/spikes/srv36/embed.py
"""ECAPA-TDNN embedding wrapper for the srv-36 Phase-0 spike (throwaway)."""
from __future__ import annotations
import functools
import numpy as np

TARGET_SR = 16000


@functools.lru_cache(maxsize=1)
def load_encoder():
    from speechbrain.inference.speaker import EncoderClassifier  # 1.0+ path
    return EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": "cpu"},
    )


def embed_pcm(pcm: bytes, sample_rate: int) -> "np.ndarray":
    """Mono int16-LE PCM -> 192-dim L2-normalised float32 embedding."""
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
```

- [ ] **Step 2: Write the conftest (sidecar dir on path) and the SKIP-gated test**

```python
# server/tts-sidecar/spikes/srv36/tests/conftest.py
import os, sys
# tts-sidecar root → so `import main` and `import spikes.srv36.*` both resolve.
_SIDE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _SIDE not in sys.path:
    sys.path.insert(0, _SIDE)
os.environ.setdefault("PRELOAD_COQUI", "0")
os.environ.setdefault("PRELOAD_KOKORO", "0")
```

```python
# server/tts-sidecar/spikes/srv36/tests/test_embed.py
import math
import numpy as np
import pytest

pytest.importorskip("speechbrain")
pytest.importorskip("torch")

from spikes.srv36.embed import embed_pcm


def _tone(sr=16000, secs=2.0, hz=140.0):
    n = int(sr * secs)
    t = np.arange(n) / sr
    return (np.sin(2 * math.pi * hz * t) * 8000).astype("<i2").tobytes()


def test_embed_is_deterministic_and_unit_norm():
    pcm = _tone()
    a = embed_pcm(pcm, 16000)
    b = embed_pcm(pcm, 16000)
    assert a.shape == (192,)
    assert np.allclose(a, b)
    assert abs(np.linalg.norm(a) - 1.0) < 1e-4
    assert float(a @ b) > 0.999
```

- [ ] **Step 3: Run the test**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_embed.py -v`
Expected: PASS where `speechbrain` + weights exist; SKIPPED otherwise. Both acceptable.

- [ ] **Step 4: README**

Create `server/tts-sidecar/spikes/srv36/README.md`: one-line `pip install speechbrain` into the sidecar venv (first run downloads ~20 MB ECAPA weights to the HF cache); the run order (`render → run_e1/e2/e3 → synthesize`); and an **Optional Qwen** section noting that `run_e4` + the fallback enrichment need the designed Qwen voices from `samples/the-coalfall-commission/.audiobook/` to be present in the workspace, and are skipped if absent.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/spikes/
git commit -m "feat(sidecar): srv-36 phase-0 spike scaffold + ECAPA embed wrapper"
```

---

### Task 2: Pure metric helpers

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/metrics.py`
- Create: `server/tts-sidecar/spikes/srv36/tests/test_metrics.py`

**Interfaces:**
- Produces: `cosine(a,b)->float`; `eer(genuine,impostor)->{"eer","threshold"}`; `intra_speaker_spread(sims)->{"mean","std","p05"}`; `residual_value_by_tier(clean, defects, cutoff)->{tier:{flagged_fraction,n}, clean_false_positive_rate, cutoff}` (a defect is "flagged" when its similarity-to-reference is **below** `cutoff`); `coverage(durations, floor)->float`.

- [ ] **Step 1: Write the failing tests**

```python
# server/tts-sidecar/spikes/srv36/tests/test_metrics.py
from spikes.srv36.metrics import (
    cosine, eer, intra_speaker_spread, residual_value_by_tier, coverage,
)


def test_cosine_basic():
    assert cosine([1, 0], [1, 0]) == 1.0
    assert cosine([1, 0], [0, 1]) == 0.0
    assert round(cosine([1, 0], [-1, 0]), 6) == -1.0
    assert cosine([0, 0], [1, 0]) == 0.0  # zero-vector guard


def test_eer_perfectly_separable():
    out = eer(genuine=[0.9, 0.95, 0.92], impostor=[0.1, 0.2, 0.15])
    assert out["eer"] == 0.0
    assert 0.2 < out["threshold"] < 0.9


def test_eer_total_overlap_is_high():
    assert eer(genuine=[0.5, 0.5], impostor=[0.5, 0.5])["eer"] >= 0.5


def test_intra_speaker_spread():
    out = intra_speaker_spread([0.90, 0.92, 0.88, 0.91])
    assert 0.88 <= out["mean"] <= 0.92
    assert out["std"] >= 0.0
    assert out["p05"] <= out["mean"]


def test_residual_value_by_tier_flags_below_cutoff():
    out = residual_value_by_tier(
        clean=[0.95, 0.96, 0.94],
        defects={"subtle": [0.80, 0.97, 0.78], "gross": [0.30, 0.20, 0.25]},
        cutoff=0.85,
    )
    assert round(out["subtle"]["flagged_fraction"], 3) == 0.667
    assert out["subtle"]["n"] == 3
    assert out["gross"]["flagged_fraction"] == 1.0
    assert out["clean_false_positive_rate"] == 0.0


def test_coverage():
    assert coverage([1.0, 2.0, 3.0, 0.5], floor=2.0) == 0.5
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_metrics.py -v`
Expected: FAIL — `ModuleNotFoundError: spikes.srv36.metrics`.

- [ ] **Step 3: Implement**

```python
# server/tts-sidecar/spikes/srv36/metrics.py
"""Pure measurement helpers for the srv-36 Phase-0 spike. numpy only."""
from __future__ import annotations
import numpy as np


def cosine(a, b) -> float:
    a = np.asarray(a, dtype=np.float64); b = np.asarray(b, dtype=np.float64)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(np.dot(a, b) / (na * nb)) if na and nb else 0.0


def eer(genuine, impostor) -> dict:
    g = np.asarray(genuine, dtype=np.float64); im = np.asarray(impostor, dtype=np.float64)
    cands = np.unique(np.concatenate([g, im, [g.min() - 1e-6, im.max() + 1e-6]])) \
        if g.size and im.size else np.array([0.0])
    best = {"eer": 1.0, "threshold": 0.0, "gap": 2.0}
    for thr in cands:
        far = float(np.mean(im >= thr)) if im.size else 0.0
        frr = float(np.mean(g < thr)) if g.size else 0.0
        if abs(far - frr) < best["gap"]:
            best = {"eer": (far + frr) / 2.0, "threshold": float(thr), "gap": abs(far - frr)}
    return {"eer": best["eer"], "threshold": best["threshold"]}


def intra_speaker_spread(sims) -> dict:
    arr = np.asarray(sims, dtype=np.float64)
    return {"mean": float(arr.mean()), "std": float(arr.std()),
            "p05": float(np.percentile(arr, 5))}


def residual_value_by_tier(clean, defects: dict, cutoff: float) -> dict:
    out: dict = {}
    for tier, scores in defects.items():
        s = np.asarray(scores, dtype=np.float64)
        out[tier] = {"flagged_fraction": float(np.mean(s < cutoff)) if s.size else 0.0,
                     "n": int(s.size)}
    c = np.asarray(clean, dtype=np.float64)
    out["clean_false_positive_rate"] = float(np.mean(c < cutoff)) if c.size else 0.0
    out["cutoff"] = float(cutoff)
    return out


def coverage(durations, floor: float) -> float:
    d = np.asarray(durations, dtype=np.float64)
    return float(np.mean(d >= floor)) if d.size else 0.0
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_metrics.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/metrics.py server/tts-sidecar/spikes/srv36/tests/test_metrics.py
git commit -m "feat(sidecar): srv-36 spike pure metric helpers"
```

---

### Task 3: Pure PCM injection transforms

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/inject.py`
- Create: `server/tts-sidecar/spikes/srv36/tests/test_inject.py`

**Interfaces:**
- Produces (mono int16-LE `bytes` in/out): `truncate(pcm, sr, keep_sec)`; `clip(pcm, ceiling=0.6)`; `reverse_span(pcm, sr, start_sec, dur_sec)`; `splice(pcm_a, pcm_b, sr, at_sec)`.

- [ ] **Step 1: Write the failing tests**

```python
# server/tts-sidecar/spikes/srv36/tests/test_inject.py
import numpy as np
from spikes.srv36.inject import truncate, clip, reverse_span, splice

SR = 16000
def _ramp(n): return (np.linspace(-30000, 30000, n)).astype("<i2").tobytes()


def test_truncate_keeps_only_requested_seconds():
    assert len(truncate(_ramp(SR), SR, 0.25)) == int(SR * 0.25) * 2


def test_clip_bounds_amplitude():
    out = np.frombuffer(clip(_ramp(SR), ceiling=0.5), dtype="<i2")
    assert out.max() <= int(0.5 * 32767) + 1
    assert out.min() >= -int(0.5 * 32767) - 1


def test_reverse_span_changes_only_the_span():
    pcm = _ramp(SR)
    b = np.frombuffer(reverse_span(pcm, SR, 0.0, 0.5), dtype="<i2")
    a = np.frombuffer(pcm, dtype="<i2"); half = SR // 2
    assert np.array_equal(b[:half], a[:half][::-1])
    assert np.array_equal(b[half:], a[half:])


def test_splice_lengthens_by_inserted_clip():
    a, b = _ramp(SR), _ramp(SR // 2)
    assert len(splice(a, b, SR, 0.5)) == len(a) + len(b)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_inject.py -v`
Expected: FAIL importing `inject`.

- [ ] **Step 3: Implement**

```python
# server/tts-sidecar/spikes/srv36/inject.py
"""Deterministic PCM corruption transforms — the 'constructed garble' defect
class for srv-36 E1 (spec §2.0). Mono int16-LE bytes in/out. numpy only."""
from __future__ import annotations
import numpy as np
def _arr(pcm): return np.frombuffer(pcm, dtype="<i2").copy()


def truncate(pcm, sample_rate, keep_sec):
    return _arr(pcm)[: int(sample_rate * keep_sec)].astype("<i2").tobytes()


def clip(pcm, ceiling=0.6):
    lim = int(ceiling * 32767)
    return np.clip(_arr(pcm).astype(np.int32), -lim, lim).astype("<i2").tobytes()


def reverse_span(pcm, sample_rate, start_sec, dur_sec):
    a = _arr(pcm); s = int(sample_rate * start_sec)
    e = min(len(a), s + int(sample_rate * dur_sec)); a[s:e] = a[s:e][::-1]
    return a.astype("<i2").tobytes()


def splice(pcm_a, pcm_b, sample_rate, at_sec):
    a, b = _arr(pcm_a), _arr(pcm_b); at = int(sample_rate * at_sec)
    return np.concatenate([a[:at], b, a[at:]]).astype("<i2").tobytes()
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_inject.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/inject.py server/tts-sidecar/spikes/srv36/tests/test_inject.py
git commit -m "feat(sidecar): srv-36 spike deterministic PCM garble transforms"
```

---

### Task 4: Cast + lines data layer (real fixture, no parser)

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/spike_lines.json` (committed ground truth)
- Create: `server/tts-sidecar/spikes/srv36/cast_data.py`
- Create: `server/tts-sidecar/spikes/srv36/tests/test_cast_data.py`

**Interfaces:**
- Produces:
  - `load_cast_voices() -> dict[str, str]` — character → Kokoro voice id, read from `samples/the-coalfall-commission/.audiobook/cast.json` (`overrideTtsVoices.kokoro.name`).
  - `load_lines() -> dict[str, list[str]]` — character → real lines, from `spike_lines.json`.
  - `near_miss_voice(voice: str, pool: list[str]) -> str` — a *different same-gender* Kokoro voice (same `af_`/`am_`/`bf_`/`bm_` prefix) from the pool; raises if none.
- Consumed by: `render.py`, `run_e1`, `run_e2`.

- [ ] **Step 1: Author the ground-truth lines (real quotes from chapter one)**

```json
// server/tts-sidecar/spikes/srv36/spike_lines.json
{
  "Wren": [
    "It might be a customer.",
    "A real one?",
    "I never sigh.",
    "I'm not crying.",
    "You're told wrong."
  ],
  "Master Oduvan": [
    "Leave it. Whoever it is can knock.",
    "At this hour it's either a drunk or a debt. Neither pays better for being let in quickly.",
    "If I douse the fire, I lose the weld I've been nursing since noon.",
    "The best smith in the valley died nine years back. You'll have to make do with the second.",
    "It'll take till morning. You'll have to keep the fire company while we work."
  ],
  "Maerin": [
    "Oduvan. Bar the shutters and douse the coals.",
    "There's a dragon on the Coalfall road. Big as a barn. It's coming down the lane.",
    "No, child, a painted one. Real. And making straight for the only lit window in the valley, which is yours.",
    "Douse the fire."
  ],
  "Coalfall": [
    "I have come a long way.",
    "The villages call me Coalfall. That is not my name, but it will do.",
    "Modesty, or a sales tactic?",
    "I do not want a sword. Everyone wants me dead, and a sword would only encourage them.",
    "I have nothing but time. Begin."
  ]
}
```

- [ ] **Step 2: Write the failing tests**

```python
# server/tts-sidecar/spikes/srv36/tests/test_cast_data.py
import pytest
from spikes.srv36.cast_data import load_cast_voices, load_lines, near_miss_voice


def test_load_cast_voices_has_real_characters_and_kokoro_ids():
    v = load_cast_voices()
    assert v["Wren"] == "af_aoede"
    assert v["Master Oduvan"] == "bm_george"
    assert v["Maerin"] == "af_jessica"
    assert all(val[:3] in ("af_", "am_", "bf_", "bm_") for val in v.values())


def test_load_lines_matches_authored_characters():
    lines = load_lines()
    assert set(lines) == {"Wren", "Master Oduvan", "Maerin", "Coalfall"}
    assert all(len(v) >= 4 and all(s.strip() for s in v) for v in lines.values())


def test_near_miss_voice_is_same_gender_and_different():
    out = near_miss_voice("af_aoede", ["af_aoede", "af_jessica", "bm_george"])
    assert out == "af_jessica"           # same af_ prefix, different id
    with pytest.raises(ValueError):
        near_miss_voice("af_aoede", ["af_aoede", "bm_george"])  # no same-gender alt
```

- [ ] **Step 3: Run to verify failure**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_cast_data.py -v`
Expected: FAIL importing `cast_data`.

- [ ] **Step 4: Implement**

```python
# server/tts-sidecar/spikes/srv36/cast_data.py
"""Real fixture cast + lines for the srv-36 spike. Pure file reads — no regex."""
from __future__ import annotations
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
# tts-sidecar/spikes/srv36 -> repo root is parents[3]
REPO = HERE.parents[3]
CAST_JSON = REPO / "samples" / "the-coalfall-commission" / ".audiobook" / "cast.json"
LINES_JSON = HERE / "spike_lines.json"


def load_cast_voices() -> dict:
    data = json.loads(CAST_JSON.read_text(encoding="utf-8"))
    out = {}
    for c in data.get("characters", []):
        kok = ((c.get("overrideTtsVoices") or {}).get("kokoro") or {}).get("name")
        if kok:
            out[c.get("name")] = kok
    return out


def load_lines() -> dict:
    return json.loads(LINES_JSON.read_text(encoding="utf-8"))


def near_miss_voice(voice: str, pool: list) -> str:
    prefix = voice[:3]  # 'af_', 'am_', ...
    for v in pool:
        if v[:3] == prefix and v != voice:
            return v
    raise ValueError(f"no same-gender near-miss for {voice} in {pool}")
```

- [ ] **Step 5: Run to verify pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_cast_data.py -v`
Expected: PASS (3 tests; pure file reads — no GPU/model).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/spike_lines.json server/tts-sidecar/spikes/srv36/cast_data.py server/tts-sidecar/spikes/srv36/tests/test_cast_data.py
git commit -m "feat(sidecar): srv-36 spike real-fixture cast+lines data layer"
```

---

### Task 5: Render driver (on-box, correct engine API)

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/render.py`

**Interfaces:**
- Produces:
  - `render_clip(engine_name: str, model: str, voice: str, text: str) -> tuple[bytes, int]` — calls the real engine; returns `(pcm, sample_rate)` from the `SynthResult`.
  - `build_clips() -> dict` — renders, per character: a reference (longest line) + all line clips at their assigned Kokoro voice; writes `results/clips_manifest.json` + `results/clips/*.pcm`. Returns the manifest.
- Consumed by: every `run_eN.py`.

- [ ] **Step 1: Implement the render driver (no unit test — on-box I/O; the math it feeds IS tested in Tasks 6–9)**

```python
# server/tts-sidecar/spikes/srv36/render.py
"""On-box: render the real fixture lines through the real Kokoro engine.
Uses the VERIFIED API: ENGINES[name].synthesize(model, voice, text) -> SynthResult."""
from __future__ import annotations
import json, os
from pathlib import Path

os.environ.setdefault("PRELOAD_COQUI", "0")
os.environ.setdefault("PRELOAD_KOKORO", "0")

from main import ENGINES  # side-effect-safe: lazy load, no port bind (verified)
from spikes.srv36.cast_data import load_cast_voices, load_lines

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
CLIPS = RESULTS / "clips"
KOKORO_MODEL = "v1"  # main.py KokoroEngine expects model == "v1"


def render_clip(engine_name: str, model: str, voice: str, text: str):
    res = ENGINES[engine_name].synthesize(model, voice, text)
    return res.pcm, res.sample_rate  # SynthResult.pcm / .sample_rate (main.py:358)


def _dur_sec(pcm: bytes, sr: int) -> float:
    return len(pcm) / 2 / sr


def build_clips() -> dict:
    CLIPS.mkdir(parents=True, exist_ok=True)
    voices = load_cast_voices()
    lines = load_lines()
    manifest: dict = {}
    for ch, texts in lines.items():
        voice = voices[ch]
        slot = manifest.setdefault(ch, {"voice": voice, "reference": None, "lines": []})
        for i, text in enumerate(texts):
            pcm, sr = render_clip("kokoro", KOKORO_MODEL, voice, text)
            p = CLIPS / f"{ch.replace(' ', '_')}-{i}.pcm"
            p.write_bytes(pcm)
            slot["lines"].append({"path": str(p), "text": text,
                                  "dur_sec": _dur_sec(pcm, sr), "sr": sr})
        slot["reference"] = max(slot["lines"], key=lambda l: l["dur_sec"])["path"]
    (RESULTS / "clips_manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    m = build_clips()
    print(f"rendered {sum(len(v['lines']) for v in m.values())} clips for {len(m)} characters")
```

- [ ] **Step 2: (On-box) smoke-run**

Run on a GPU box: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.render`
Expected: prints `rendered N clips for 4 characters`; `results/clips_manifest.json` + `results/clips/*.pcm` exist. If Kokoro substitutes a missing voice, confirm the assigned ids match the installed Kokoro catalog.

- [ ] **Step 3: Commit (code only — PCM is gitignored)**

```bash
git add server/tts-sidecar/spikes/srv36/render.py
git commit -m "feat(sidecar): srv-36 spike fixture render driver (verified engine API)"
```

---

### Task 6: E1 — residual value (scripted subtle + gross tiers)

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/run_e1.py`
- Create: `server/tts-sidecar/spikes/srv36/tests/test_aggregates.py`

**Interfaces:**
- Produces: `aggregate_e1(clean_sims, defect_sims_by_tier, cutoff) -> dict` — PURE; adds `subtle_clears` (subtle flagged_fraction ≥ 0.60 AND clean FP ≤ 0.10). **Raises `ValueError` if the `subtle` tier is empty or absent** (an empty gate input is a bug, not a no-go). Plus on-box `main()` writing `results/e1.json`.

- [ ] **Step 1: Write the failing aggregate tests**

```python
# server/tts-sidecar/spikes/srv36/tests/test_aggregates.py
import pytest
from spikes.srv36.run_e1 import aggregate_e1


def test_aggregate_e1_subtle_gate_pass():
    a = aggregate_e1([0.95, 0.96, 0.94], {"subtle": [0.80, 0.78, 0.97], "gross": [0.2, 0.3]}, 0.85)
    assert a["subtle"]["flagged_fraction"] == pytest.approx(2 / 3)
    assert a["subtle_clears"] is True


def test_aggregate_e1_subtle_gate_fail_when_under_bar():
    b = aggregate_e1([0.95, 0.96], {"subtle": [0.80, 0.97, 0.98], "gross": [0.2]}, 0.85)
    assert b["subtle"]["flagged_fraction"] == pytest.approx(1 / 3)
    assert b["subtle_clears"] is False


def test_aggregate_e1_raises_on_empty_subtle():
    with pytest.raises(ValueError):
        aggregate_e1([0.95], {"subtle": [], "gross": [0.2]}, 0.85)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_aggregates.py -v`
Expected: FAIL importing `run_e1`.

- [ ] **Step 3: Implement E1 (driver scripts BOTH tiers — no manual step)**

```python
# server/tts-sidecar/spikes/srv36/run_e1.py
"""E1 — residual value: do same-config defects separate from clean renders?
Subtle = same-gender near-miss preset; Gross = distant preset + garble.
Both injected IN CODE so the gate is reproducible (spec §2.1/§3.6)."""
from __future__ import annotations
import json
from pathlib import Path

from spikes.srv36.metrics import residual_value_by_tier, eer, cosine

SUBTLE_FLAG_BAR = 0.60
CLEAN_FP_CEILING = 0.10
HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def aggregate_e1(clean_sims, defect_sims_by_tier, cutoff) -> dict:
    if not defect_sims_by_tier.get("subtle"):
        raise ValueError("subtle tier is empty — harness bug, not a no-go")
    rv = residual_value_by_tier(clean_sims, defect_sims_by_tier, cutoff)
    rv["subtle_clears"] = bool(
        rv["subtle"]["flagged_fraction"] >= SUBTLE_FLAG_BAR
        and rv["clean_false_positive_rate"] <= CLEAN_FP_CEILING
    )
    rv["bars"] = {"subtle_flag": SUBTLE_FLAG_BAR, "clean_fp_ceiling": CLEAN_FP_CEILING}
    return rv


def _pick_cutoff(clean):
    import numpy as np
    return float(np.percentile(clean, 5)) if clean else 0.5


def main():  # on-box
    from spikes.srv36.embed import embed_pcm
    from spikes.srv36.cast_data import load_cast_voices, near_miss_voice
    from spikes.srv36 import inject
    from spikes.srv36.render import render_clip, KOKORO_MODEL
    manifest = json.loads((RESULTS / "clips_manifest.json").read_text())
    voices = load_cast_voices()
    pool = sorted(set(voices.values()))

    def emb_path(p):
        d = json.loads((RESULTS / "clips_manifest.json").read_text())
        return embed_pcm(Path(p).read_bytes(), _sr_for(d, p))

    def _sr_for(d, path):
        for slot in d.values():
            for ln in slot["lines"]:
                if ln["path"] == path:
                    return ln["sr"]
        return 24000

    clean, subtle, gross = [], [], []
    for ch, slot in manifest.items():
        ref = embed_pcm(Path(slot["reference"]).read_bytes(), _sr_for(manifest, slot["reference"]))
        own = voices[ch]
        # near-miss + distant target voices
        try:
            near = near_miss_voice(own, pool)
        except ValueError:
            near = None
        distant = next((v for v in pool if v[:3] != own[:3]), None)
        for ln in slot["lines"]:
            if ln["path"] == slot["reference"]:
                continue
            pcm = Path(ln["path"]).read_bytes()
            clean.append(cosine(ref, embed_pcm(pcm, ln["sr"])))
            # GROSS: garble the clean render
            gross.append(cosine(ref, embed_pcm(inject.clip(pcm, 0.4), ln["sr"])))
            # GROSS: distant preset render
            if distant:
                dp, dsr = render_clip("kokoro", KOKORO_MODEL, distant, ln["text"])
                gross.append(cosine(ref, embed_pcm(dp, dsr)))
            # SUBTLE: same-gender near-miss preset render
            if near:
                npcm, nsr = render_clip("kokoro", KOKORO_MODEL, near, ln["text"])
                subtle.append(cosine(ref, embed_pcm(npcm, nsr)))
    out = aggregate_e1(clean, {"subtle": subtle, "gross": gross}, _pick_cutoff(clean))
    out["in_domain_eer_clean_vs_subtle"] = eer(genuine=clean, impostor=subtle)
    (RESULTS / "e1.json").write_text(json.dumps(out, indent=2))
    print("E1 subtle_clears=", out["subtle_clears"], out["bars"])


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify the aggregate tests pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_aggregates.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: (On-box) run E1** — `.venv/Scripts/python.exe -m spikes.srv36.run_e1` after `render`. Confirm `results/e1.json` has non-empty `subtle` (`n ≥ 12`: 3+ characters × ~4 non-reference lines) and a per-tier breakdown.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/run_e1.py server/tts-sidecar/spikes/srv36/tests/test_aggregates.py
git commit -m "feat(sidecar): srv-36 spike E1 residual-value (scripted subtle+gross tiers)"
```

---

### Task 7: E2 — separability + in-domain EER

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/run_e2.py`
- Modify: `server/tts-sidecar/spikes/srv36/tests/test_aggregates.py`

**Interfaces:**
- Produces: `aggregate_e2(intra_sims, inter_sims, nearmiss_sims) -> dict` → `{intra, eer_inter, eer_nearmiss, nearmiss_separable}` where `nearmiss_separable = eer_nearmiss["eer"] < 0.30`. Plus on-box `main()` → `results/e2.json`.

- [ ] **Step 1: Write the failing test (pins real values — not tautological)**

```python
# append to tests/test_aggregates.py
from spikes.srv36.run_e2 import aggregate_e2


def test_aggregate_e2_pins_separability():
    out = aggregate_e2(
        intra_sims=[0.93, 0.94, 0.92],
        inter_sims=[0.10, 0.15, 0.05],
        nearmiss_sims=[0.55, 0.60, 0.58],
    )
    assert out["intra"]["mean"] == pytest.approx(0.93, abs=0.01)
    assert out["eer_inter"]["eer"] == 0.0                 # distinct chars: separable
    assert out["eer_nearmiss"]["eer"] == 0.0              # 0.93-cluster vs 0.58: separable
    assert out["nearmiss_separable"] is True


def test_aggregate_e2_nearmiss_inseparable_when_overlapping():
    out = aggregate_e2([0.6, 0.62], [0.1, 0.1], [0.6, 0.61])  # intra ~ nearmiss
    assert out["nearmiss_separable"] is False
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_aggregates.py -k e2 -v`
Expected: FAIL importing `run_e2`.

- [ ] **Step 3: Implement E2**

```python
# server/tts-sidecar/spikes/srv36/run_e2.py
"""E2 — separability & in-domain EER: is the SAME voice tight, and are
same-gender near-miss presets even separable from it?"""
from __future__ import annotations
import json
from pathlib import Path
from spikes.srv36.metrics import intra_speaker_spread, eer, cosine

NEARMISS_EER_BAR = 0.30
HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def aggregate_e2(intra_sims, inter_sims, nearmiss_sims) -> dict:
    en = eer(genuine=intra_sims, impostor=nearmiss_sims)
    return {
        "intra": intra_speaker_spread(intra_sims),
        "eer_inter": eer(genuine=intra_sims, impostor=inter_sims),
        "eer_nearmiss": en,
        "nearmiss_separable": bool(en["eer"] < NEARMISS_EER_BAR),
        "bar": {"nearmiss_eer": NEARMISS_EER_BAR},
    }


def main():  # on-box
    from spikes.srv36.embed import embed_pcm
    from spikes.srv36.cast_data import load_cast_voices, near_miss_voice
    from spikes.srv36.render import render_clip, KOKORO_MODEL
    manifest = json.loads((RESULTS / "clips_manifest.json").read_text())
    voices = load_cast_voices(); pool = sorted(set(voices.values()))
    refs = {ch: embed_pcm(Path(s["reference"]).read_bytes(),
            next(l["sr"] for l in s["lines"] if l["path"] == s["reference"]))
            for ch, s in manifest.items()}
    intra, inter, nearmiss = [], [], []
    for ch, slot in manifest.items():
        try:
            near = near_miss_voice(voices[ch], pool)
        except ValueError:
            near = None
        for ln in slot["lines"]:
            e = embed_pcm(Path(ln["path"]).read_bytes(), ln["sr"])
            intra.append(cosine(refs[ch], e))
            for other, oref in refs.items():
                if other != ch:
                    inter.append(cosine(oref, e))
            if near:
                npcm, nsr = render_clip("kokoro", KOKORO_MODEL, near, ln["text"])
                nearmiss.append(cosine(refs[ch], embed_pcm(npcm, nsr)))
    out = aggregate_e2(intra, inter, nearmiss)
    (RESULTS / "e2.json").write_text(json.dumps(out, indent=2))
    print("E2 intra=", out["intra"], "nearmiss_separable=", out["nearmiss_separable"])


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify the aggregate tests pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_aggregates.py -k e2 -v`
Expected: PASS (2 tests).

- [ ] **Step 5: (On-box) run E2** — `.venv/Scripts/python.exe -m spikes.srv36.run_e2`; confirm `results/e2.json` has non-empty `intra` + `nearmiss`.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/run_e2.py server/tts-sidecar/spikes/srv36/tests/test_aggregates.py
git commit -m "feat(sidecar): srv-36 spike E2 separability + in-domain EER"
```

---

### Task 8: E3 — clip-length floor + coverage

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/run_e3.py`
- Modify: `server/tts-sidecar/spikes/srv36/tests/test_aggregates.py`

**Interfaces:**
- Produces: `aggregate_e3(length_to_sims, char_durations, floor) -> dict` → `{std_by_length, min_scorable_sec, character_coverage, floor}` where `min_scorable_sec` = smallest length whose cosine-std vs the 5 s embedding ≤ 0.05. Plus on-box `main()` → `results/e3.json`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_aggregates.py
from spikes.srv36.run_e3 import aggregate_e3


def test_aggregate_e3_picks_floor_and_coverage():
    out = aggregate_e3(
        length_to_sims={0.5: [0.6, 0.9, 0.7], 2.0: [0.97, 0.98, 0.96], 5.0: [1.0, 1.0, 1.0]},
        char_durations=[0.5, 1.0, 3.0, 4.0],
        floor=2.0,
    )
    assert out["min_scorable_sec"] == 2.0
    assert out["character_coverage"] == 0.5
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_aggregates.py -k e3 -v`
Expected: FAIL importing `run_e3`.

- [ ] **Step 3: Implement E3**

```python
# server/tts-sidecar/spikes/srv36/run_e3.py
"""E3 — clip length vs embedding stability, and realistic checked-coverage."""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
from spikes.srv36.metrics import coverage, cosine

STD_OK = 0.05
HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def aggregate_e3(length_to_sims: dict, char_durations, floor: float) -> dict:
    per_len = {float(k): float(np.std(v)) for k, v in length_to_sims.items()}
    scorable = sorted(L for L, s in per_len.items() if s <= STD_OK)
    return {
        "std_by_length": per_len,
        "min_scorable_sec": (scorable[0] if scorable else None),
        "character_coverage": coverage(char_durations, floor),
        "floor": floor, "std_ok": STD_OK,
    }


def main():  # on-box
    from spikes.srv36.embed import embed_pcm
    manifest = json.loads((RESULTS / "clips_manifest.json").read_text())
    lengths = [0.5, 1.0, 2.0, 3.0, 5.0]
    length_to_sims = {L: [] for L in lengths}
    char_durs = []
    for ch, slot in manifest.items():
        for ln in slot["lines"]:
            char_durs.append(ln["dur_sec"])  # all spike chars are non-narrator
            if ln["dur_sec"] < 5.0:
                continue
            pcm, sr = Path(ln["path"]).read_bytes(), ln["sr"]
            full = embed_pcm(pcm[: int(5.0 * sr) * 2], sr)
            for L in lengths:
                seg = embed_pcm(pcm[: int(L * sr) * 2], sr)
                length_to_sims[L].append(cosine(full, seg))
    out = aggregate_e3(length_to_sims, char_durs, floor=2.0)
    (RESULTS / "e3.json").write_text(json.dumps(out, indent=2))
    print("E3 min_scorable_sec=", out["min_scorable_sec"], "coverage=", out["character_coverage"])


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify the aggregate test passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_aggregates.py -k e3 -v`
Expected: PASS.

- [ ] **Step 5: (On-box) run E3** — `.venv/Scripts/python.exe -m spikes.srv36.run_e3`. If no fixture line reaches 5 s, the README notes rendering a few concatenated lines per character to get ≥5 s references for the length sweep. Confirm `results/e3.json` reports `min_scorable_sec` + `character_coverage`.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/run_e3.py server/tts-sidecar/spikes/srv36/tests/test_aggregates.py
git commit -m "feat(sidecar): srv-36 spike E3 clip-length floor + coverage"
```

---

### Task 9: E4 (optional) + findings synthesis + go/no-go

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/run_e4.py`
- Create: `server/tts-sidecar/spikes/srv36/synthesize.py`
- Create: `server/tts-sidecar/spikes/srv36/FINDINGS.md` (filled by the on-box run)
- Modify: `server/tts-sidecar/spikes/srv36/tests/test_aggregates.py`

**Interfaces:**
- Produces:
  - `aggregate_e4(cross_emotion_sims, cross_character_sims) -> dict` → `{emotion_shift_dist, cross_char_dist, emotion_matching_needed}` (needed = emotion dist ≥ 0.5 × char dist). **Optional — never affects the recommendation.**
  - `decide(e1, e2, e3, e4) -> dict` → `{recommendation: "go"|"no-go", reasons}`. **Go** iff `e1.subtle_clears` AND `e2.nearmiss_separable` AND `e3.character_coverage ≥ 0.5`. `e4` only adds a Phase-2 note.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_aggregates.py
from spikes.srv36.run_e4 import aggregate_e4
from spikes.srv36.synthesize import decide


def test_aggregate_e4_flags_emotion_sensitivity():
    assert aggregate_e4([0.6, 0.65], [0.2, 0.25])["emotion_matching_needed"] is False
    assert aggregate_e4([0.2], [0.1])["emotion_matching_needed"] is True


def test_decide_go_requires_all_three():
    go = decide({"subtle_clears": True}, {"nearmiss_separable": True},
                {"character_coverage": 0.7}, {"emotion_matching_needed": True})
    assert go["recommendation"] == "go"
    assert "phase2_note" in go


def test_decide_nogo_when_subtle_fails():
    nogo = decide({"subtle_clears": False}, {"nearmiss_separable": True},
                  {"character_coverage": 0.9}, {})
    assert nogo["recommendation"] == "no-go"
    assert any("subtle" in r for r in nogo["reasons"])


def test_decide_recommendation_is_exactly_go_or_nogo():
    out = decide({"subtle_clears": True}, {"nearmiss_separable": False},
                 {"character_coverage": 0.2}, {})
    assert out["recommendation"] in ("go", "no-go")
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_aggregates.py -k "e4 or decide" -v`
Expected: FAIL importing `run_e4` / `synthesize`.

- [ ] **Step 3: Implement E4 + synthesize**

```python
# server/tts-sidecar/spikes/srv36/run_e4.py
"""E4 (OPTIONAL) — does emotion move the speaker embedding? Phase-2 input only;
NEVER affects the go/no-go. Needs designed Qwen emotion variants; skipped if absent."""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def aggregate_e4(cross_emotion_sims, cross_character_sims) -> dict:
    emo = 1.0 - float(np.mean(cross_emotion_sims))
    char = 1.0 - float(np.mean(cross_character_sims))
    return {"emotion_shift_dist": emo, "cross_char_dist": char,
            "emotion_matching_needed": bool(emo >= 0.5 * char)}


def main():  # on-box, optional — see README; writes {} if Qwen variants absent
    edir = RESULTS / "emotions"
    if not edir.exists():
        (RESULTS / "e4.json").write_text(json.dumps({"skipped": "no qwen emotion clips"}))
        print("E4 skipped (no designed Qwen emotion variants)")
        return
    from spikes.srv36.embed import embed_pcm
    from spikes.srv36.metrics import cosine
    embs = {p.stem: embed_pcm(p.read_bytes(), 24000) for p in edir.glob("*.pcm")}
    neutral = embs["neutral"]
    cross_emo = [cosine(neutral, v) for k, v in embs.items() if k not in ("neutral", "other_char")]
    cross_char = [cosine(neutral, embs["other_char"])] if "other_char" in embs else [0.0]
    out = aggregate_e4(cross_emo, cross_char)
    (RESULTS / "e4.json").write_text(json.dumps(out, indent=2))
    print("E4 emotion_matching_needed=", out["emotion_matching_needed"])


if __name__ == "__main__":
    main()
```

```python
# server/tts-sidecar/spikes/srv36/synthesize.py
"""Reads e1..e4 results -> go/no-go recommendation (spec §2.1/§2.2)."""
from __future__ import annotations
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
COVERAGE_BAR = 0.50


def decide(e1: dict, e2: dict, e3: dict, e4: dict) -> dict:
    reasons = []
    subtle = bool(e1.get("subtle_clears"))
    nearmiss = bool(e2.get("nearmiss_separable"))
    cov_ok = float(e3.get("character_coverage", 0.0)) >= COVERAGE_BAR
    if not subtle:
        reasons.append("E1 subtle-tier defects do not separate from clean renders → "
                       "acoustic only catches the gross/different-character case "
                       "config-drift already covers.")
    if not nearmiss:
        reasons.append("E2 near-miss presets are not separable → wrong-preset cannot be "
                       "honestly detected.")
    if not cov_ok:
        reasons.append(f"E3 character coverage below {COVERAGE_BAR:.0%} → most dialogue "
                       "would be inconclusive.")
    go = subtle and nearmiss and cov_ok
    if go:
        reasons.append("Subtle same-config defects separate, near-miss is separable, and "
                       "coverage is adequate → acoustic adds real residual value.")
    out = {"recommendation": "go" if go else "no-go", "reasons": reasons}
    if e4.get("emotion_matching_needed"):
        out["phase2_note"] = ("E4: emotion materially shifts the embedding → Phase-2 "
                              "consistency must be per-emotion, not a global centroid.")
    return out


def write_findings() -> dict:  # on-box
    e = {n: json.loads((RESULTS / f"{n}.json").read_text()) for n in ("e1", "e2", "e3", "e4")}
    d = decide(e["e1"], e["e2"], e["e3"], e["e4"])
    lines = [
        "# srv-36 Phase 0 — Findings", "",
        f"## Recommendation: **{d['recommendation'].upper()}**", "",
        *[f"- {r}" for r in d["reasons"]], "",
        "## Measured numbers",
        f"- In-domain EER (clean vs subtle): `{e['e1'].get('in_domain_eer_clean_vs_subtle')}`",
        f"- E1 per-tier: `{json.dumps({k: e['e1'][k] for k in ('subtle','gross','clean_false_positive_rate','subtle_clears') if k in e['e1']})}`",
        f"- E2 intra-speaker spread: `{e['e2'].get('intra')}` ; near-miss EER: `{e['e2'].get('eer_nearmiss')}`",
        f"- E3 min scorable sec: `{e['e3'].get('min_scorable_sec')}` ; character coverage: `{e['e3'].get('character_coverage')}`",
        f"- E4 (optional): `{json.dumps(e['e4'])}`", "",
        d.get("phase2_note", ""), "",
        "_Calibration anchor = the measured in-domain EER above, NOT VoxCeleb 0.9%._",
    ]
    (HERE / "FINDINGS.md").write_text("\n".join(lines), encoding="utf-8")
    return d


if __name__ == "__main__":
    print(write_findings())
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_aggregates.py -k "e4 or decide" -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the FULL spike suite**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests -v`
Expected: all pure tests PASS; `test_embed.py` PASS or SKIP per weights.

- [ ] **Step 6: (On-box) generate FINDINGS.md and commit the deliverable**

Run after E1–E3 (E4 optional): `.venv/Scripts/python.exe -m spikes.srv36.run_e4 && .venv/Scripts/python.exe -m spikes.srv36.synthesize`. Review `FINDINGS.md` (recommendation is `go` or `no-go` with measured numbers).

```bash
git add server/tts-sidecar/spikes/srv36/run_e4.py server/tts-sidecar/spikes/srv36/synthesize.py server/tts-sidecar/spikes/srv36/tests/test_aggregates.py
git add -f server/tts-sidecar/spikes/srv36/FINDINGS.md server/tts-sidecar/spikes/srv36/results/e1.json server/tts-sidecar/spikes/srv36/results/e2.json server/tts-sidecar/spikes/srv36/results/e3.json server/tts-sidecar/spikes/srv36/results/e4.json
git commit -m "feat(sidecar): srv-36 phase-0 findings + go/no-go recommendation"
```

- [ ] **Step 7: Act on the recommendation (spec §2.2 / §2.3 / §8)**

- **no-go**: comment FINDINGS on #665; close it `wont-fix-acoustic`; mark the spec `superseded`; confirm fs-51 (#973) unaffected; record the §2.3 decision on the config-drift `25/40` cuts (retire-as-placeholder or re-file).
- **go**: open the srv-36 Phase-1 plan (separate session, seeded by the measured EER / floor / coverage); update #665 `type:chore → type:feature`.

---

## Self-Review

**Spec coverage (Phase 0 only):**
- §2.0 injectable defects → near-miss/distant preset + garble scripted in `run_e1` (Task 6); fallback/E4 optional. ✓
- §2 E1–E4 → Tasks 6–9. ✓
- §2.1 subtle-tier gate + measured anchor → `aggregate_e1.subtle_clears` (raises on empty) + E2 EER + `decide`. ✓
- §2.2 `{go|no-go}` only → `decide` + `test_decide_recommendation_is_exactly_go_or_nogo`. ✓
- §2.3 #665 literal ask → Task 9 Step 7. ✓
- §0.2 fs-51 decoupling → Task 9 Step 7. ✓
- Throwaway / no production code → File Structure confined to `spikes/srv36/`. ✓
- R2 anchor = in-domain EER → E1/E2 EER + FINDINGS footer. ✓
- R3 coverage honesty → E3 `character_coverage`. ✓

**Blocker fixes from the plan review (all applied):**
- B1 engine API → `render_clip` uses `synthesize(model, voice, text) -> SynthResult`, reads `.pcm`/`.sample_rate`; no hardcoded 24000. ✓
- B2 false `test:sidecar` claim → Global Constraints state direct pytest invocation only. ✓
- B3 invented cast → real voices from `cast.json`, real lines in `spike_lines.json`. ✓
- B4 broken parser → dropped; ground-truth line map. ✓
- B5 manual subtle tier → scripted in `run_e1.main()`; `aggregate_e1` raises on empty subtle. ✓
- N1 vacuous tests → E2/cast tests pin real values. ✓
- N2 raw `dot` → `metrics.cosine` everywhere. ✓
- N3 hyphenated dir → package `srv36`. ✓

**Placeholder scan:** the only operator actions are the on-box experiment RUNS (rendering needs a GPU) and the optional Qwen E4 — both fully specified, no `TODO`/`TBD`. All pure code is complete with tests.

**Type consistency:** `render_clip(engine, model, voice, text)->(pcm,sr)`, `embed_pcm(pcm,sr)->ndarray`, `cosine`, `eer->{eer,threshold}`, `residual_value_by_tier->{tier:{flagged_fraction,n},clean_false_positive_rate,cutoff}`, `aggregate_e1..e4`, `decide(e1,e2,e3,e4)->{recommendation,reasons}` consistent across tasks/tests.

---

## Notes for the implementer

- **Tasks 1–4, and the aggregate/decide halves of 6–9, are TDD'd and run anywhere** (numpy/pytest). Do these first; no GPU.
- **On-box runs (Task 5 Step 2; Tasks 6–8 Step 5; Task 9 Step 6) need a GPU box** with the sidecar venv + `speechbrain` + Kokoro weights; they produce the committed `results/*.json` + `FINDINGS.md`.
- **`render.py` and `run_e1`'s distant/near-miss renders are the only code touching `main.py`** — via the verified `ENGINES[name].synthesize(model, voice, text)` contract. If the installed Kokoro catalog lacks an assigned voice id, Kokoro substitutes; confirm the ids in `cast.json` are installed before trusting the numbers.
- Run pytest from `server/tts-sidecar` (rootdir) so `import main` and `import spikes.srv36.*` resolve.
