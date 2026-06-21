# srv-36 Phase 0 — Residual-Value Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a throwaway measurement harness that answers, on real TTS output, whether an ECAPA speaker-embedding check can flag *same-config* render defects (silent fallback, wrong preset, garble) that the existing config-drift detector is blind to — and emit a committed `{go|no-go}` recommendation that gates whether srv-36 Phase 1 is ever built.

**Architecture:** A self-contained Python package under `server/tts-sidecar/spikes/srv-36/`, run in the existing sidecar venv (which already has torch + the TTS engines; we add `speechbrain`). Pure helpers (cosine, EER, residual-value-by-tier, PCM injection transforms, coverage, the go/no-go decision) are TDD'd in the sidecar pytest harness. Experiment *drivers* (E1–E4) render the canonical fixture on a GPU box, feed real embeddings into the pure aggregators, and write `eN.json`. A final synthesizer reads the four result files and produces `FINDINGS.md`. **No production code, no settings, no events, no sidecar engine — this is throwaway research.**

**Tech Stack:** Python 3.11/3.12, pytest, numpy (already a torch dep), SpeechBrain ECAPA-TDNN (`spkrec-ecapa-voxceleb`), the existing sidecar Kokoro/Qwen engines.

## Global Constraints

- **Spike is throwaway/committed-for-reproducibility, NOT production.** No changes to `main.py`, no new endpoint, no config-registry keys, no `segments.json` changes. Everything lives under `server/tts-sidecar/spikes/srv-36/`.
- **Verified injection reality (spec §2.0):** there is NO seed surface in synthesis; Kokoro is deterministic ONNX; Qwen is unseeded. The ONLY deterministically producible same-config defects are: (1) **forced fallback** — synthesize a line with Kokoro while its reference stayed Qwen-clean; (2) **wrong preset** — synthesize with a different preset than the reference, stratified into same-gender near-miss (subtle) + distant (gross); (3) **constructed garble** — deterministic post-synth PCM corruption of a clean render. **Voice bleed is observational-only and is NEVER part of the go/no-go.**
- **The gate is judged on the SUBTLE tier** (spec §2.1). A high pooled flag-rate carried by the gross tier does NOT clear the gate. Every residual-value number is reported per tier.
- **Calibration anchor is the MEASURED in-domain EER, never the VoxCeleb 0.9%** (spec §2.1/R2).
- **Canonical fixture:** `server/src/__fixtures__/the-coalfall-commission.md` (14 characters, committed, safe to use freely).
- **Recommendation field is exactly one of `{go, no-go}`** (spec §2.2) — there is no "descope to wrong-speaker."
- Sidecar tests run via `npm run test:sidecar` (pytest), or directly `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests -v`. Model-dependent tests SKIP+exit-0 when the venv/weights are absent (mirrors the existing sidecar test convention).
- All audio is mono int16 little-endian PCM at the engine's native sample rate; ECAPA expects 16 kHz float — resample at embed time.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/tts-sidecar/spikes/srv-36/__init__.py` | package marker |
| `server/tts-sidecar/spikes/srv-36/README.md` | how to run the spike on a GPU box; what each artifact means |
| `server/tts-sidecar/spikes/srv-36/embed.py` | ECAPA load + `embed_pcm(pcm, sr) -> np.ndarray` (192-dim, L2-normalised) |
| `server/tts-sidecar/spikes/srv-36/metrics.py` | PURE: `cosine`, `eer`, `intra_speaker_spread`, `residual_value_by_tier`, `coverage` |
| `server/tts-sidecar/spikes/srv-36/inject.py` | PURE PCM transforms: `truncate`, `clip`, `reverse_span`, `splice` |
| `server/tts-sidecar/spikes/srv-36/render_fixture.py` | on-box: parse fixture → render per-character reference + line clips via the real engines → clip manifest |
| `server/tts-sidecar/spikes/srv-36/run_e1.py` | E1 residual-value: pure `aggregate_e1` + on-box driver → `results/e1.json` |
| `server/tts-sidecar/spikes/srv-36/run_e2.py` | E2 separability + in-domain EER + preset near-miss: pure `aggregate_e2` + driver → `results/e2.json` |
| `server/tts-sidecar/spikes/srv-36/run_e3.py` | E3 clip-length variance + coverage: pure `aggregate_e3` + driver → `results/e3.json` |
| `server/tts-sidecar/spikes/srv-36/run_e4.py` | E4 emotion shift: pure `aggregate_e4` + driver → `results/e4.json` |
| `server/tts-sidecar/spikes/srv-36/synthesize.py` | PURE `decide(e1,e2,e3,e4) -> {recommendation, reasons}` + writes `FINDINGS.md` |
| `server/tts-sidecar/spikes/srv-36/tests/test_embed.py` | embed determinism / self-cosine (SKIP-gated on weights) |
| `server/tts-sidecar/spikes/srv-36/tests/test_metrics.py` | pure metric helpers |
| `server/tts-sidecar/spikes/srv-36/tests/test_inject.py` | pure PCM transforms |
| `server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py` | `aggregate_e1..e4` + `decide` on fake data |
| `server/tts-sidecar/spikes/srv-36/results/.gitkeep` | result JSONs land here from the on-box run |
| `server/tts-sidecar/spikes/srv-36/FINDINGS.md` | the committed deliverable (go/no-go + all measured numbers) |

**Tooling note for every task:** `PY="server/tts-sidecar/.venv/Scripts/python.exe"`. If that venv is absent (fresh clone) the model-dependent steps SKIP; pure-helper tests still run under any Python with numpy/pytest.

---

### Task 1: Package scaffold + ECAPA embed wrapper

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/__init__.py`
- Create: `server/tts-sidecar/spikes/srv-36/tests/__init__.py`
- Create: `server/tts-sidecar/spikes/srv-36/results/.gitkeep` (empty)
- Create: `server/tts-sidecar/spikes/srv-36/embed.py`
- Create: `server/tts-sidecar/spikes/srv-36/tests/test_embed.py`

**Interfaces:**
- Produces: `embed_pcm(pcm: bytes, sample_rate: int) -> np.ndarray` — a 192-dim float32 L2-normalised embedding; `load_encoder() -> EncoderClassifier` (cached). Consumed by every `run_eN.py`.

- [ ] **Step 1: Write the embed wrapper**

```python
# server/tts-sidecar/spikes/srv-36/embed.py
"""ECAPA-TDNN embedding wrapper for the srv-36 Phase-0 spike (throwaway)."""
from __future__ import annotations
import functools
import numpy as np

TARGET_SR = 16000  # ECAPA expects 16 kHz


@functools.lru_cache(maxsize=1)
def load_encoder():
    # Imported lazily so pure-helper tests never need speechbrain/torch.
    import torch
    from speechbrain.inference.speaker import EncoderClassifier
    return EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": "cpu"},
    )


def _pcm_to_float_16k(pcm: bytes, sample_rate: int) -> "np.ndarray":
    import torchaudio  # noqa: F401  (only for resample); torch is a sidecar dep
    import torch
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    t = torch.from_numpy(audio).unsqueeze(0)
    if sample_rate != TARGET_SR:
        t = torchaudio.functional.resample(t, sample_rate, TARGET_SR)
    return t


def embed_pcm(pcm: bytes, sample_rate: int) -> "np.ndarray":
    """Mono int16-LE PCM -> 192-dim L2-normalised float32 embedding."""
    import torch
    wav = _pcm_to_float_16k(pcm, sample_rate)
    enc = load_encoder()
    with torch.no_grad():
        emb = enc.encode_batch(wav).squeeze().cpu().numpy().astype(np.float32)
    norm = np.linalg.norm(emb)
    return emb / norm if norm > 0 else emb
```

- [ ] **Step 2: Write the SKIP-gated determinism test**

```python
# server/tts-sidecar/spikes/srv-36/tests/test_embed.py
import math
import numpy as np
import pytest

pytest.importorskip("speechbrain")
pytest.importorskip("torch")

from spikes_srv36_embed import embed_pcm  # see conftest path shim below


def _tone(sr=16000, secs=2.0, hz=140.0):
    n = int(sr * secs)
    t = np.arange(n) / sr
    return (np.sin(2 * math.pi * hz * t) * 8000).astype("<i2").tobytes()


def test_embed_is_deterministic_and_unit_norm():
    pcm = _tone()
    a = embed_pcm(pcm, 16000)
    b = embed_pcm(pcm, 16000)
    assert a.shape == (192,)
    assert np.allclose(a, b)                       # deterministic
    assert abs(np.linalg.norm(a) - 1.0) < 1e-4     # L2-normalised
    assert float(a @ b) > 0.999                    # self-cosine ~ 1
```

- [ ] **Step 3: Add a conftest path shim so tests import the spike package**

```python
# server/tts-sidecar/spikes/srv-36/tests/conftest.py
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
# Expose modules under short aliases used by tests.
for _m in ("embed", "metrics", "inject", "run_e1", "run_e2", "run_e3", "run_e4", "synthesize"):
    try:
        sys.modules.setdefault(f"spikes_srv36_{_m}", importlib.import_module(_m))
    except Exception:
        pass  # model-dependent modules may fail to import without weights
```

- [ ] **Step 4: Run the test**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_embed.py -v`
Expected: PASS on a box with `speechbrain` + weights; SKIPPED (importorskip) on a box without them. Either is acceptable.

- [ ] **Step 5: Add speechbrain to the spike's documented deps**

Create `server/tts-sidecar/spikes/srv-36/README.md` with a one-line install: `pip install speechbrain` (into the sidecar venv) and a note that first run downloads the ECAPA weights (~20 MB) to the HF cache.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv-36/
git commit -m "feat(sidecar): srv-36 phase-0 spike scaffold + ECAPA embed wrapper"
```

---

### Task 2: Pure metric helpers

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/metrics.py`
- Create: `server/tts-sidecar/spikes/srv-36/tests/test_metrics.py`

**Interfaces:**
- Produces:
  - `cosine(a, b) -> float`
  - `eer(genuine: list[float], impostor: list[float]) -> dict` → `{"eer": float, "threshold": float}` (operating point where false-accept == false-reject; scores are cosine similarities, higher = more same-speaker)
  - `intra_speaker_spread(sims: list[float]) -> dict` → `{"mean": float, "std": float, "p05": float}`
  - `residual_value_by_tier(clean: list[float], defects: dict[str, list[float]], cutoff: float) -> dict` → per-tier flagged-fraction + clean false-positive rate. A defect is "flagged" when its similarity-to-reference is **below** `cutoff`.
  - `coverage(durations: list[float], floor: float) -> float` → fraction of durations ≥ floor.
- Consumed by: `run_e1..e4`, `synthesize`.

- [ ] **Step 1: Write the failing tests**

```python
# server/tts-sidecar/spikes/srv-36/tests/test_metrics.py
import numpy as np
from spikes_srv36_metrics import (
    cosine, eer, intra_speaker_spread, residual_value_by_tier, coverage,
)


def test_cosine_basic():
    assert cosine([1, 0], [1, 0]) == 1.0
    assert cosine([1, 0], [0, 1]) == 0.0
    assert round(cosine([1, 0], [-1, 0]), 6) == -1.0


def test_eer_perfectly_separable():
    out = eer(genuine=[0.9, 0.95, 0.92], impostor=[0.1, 0.2, 0.15])
    assert out["eer"] == 0.0
    assert 0.2 < out["threshold"] < 0.9


def test_eer_total_overlap_is_high():
    out = eer(genuine=[0.5, 0.5], impostor=[0.5, 0.5])
    assert out["eer"] >= 0.5


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
    # subtle: 2 of 3 below 0.85 -> 0.667 ; gross: 3 of 3 -> 1.0
    assert round(out["subtle"]["flagged_fraction"], 3) == 0.667
    assert out["gross"]["flagged_fraction"] == 1.0
    # clean false-positive: 0 of 3 below cutoff
    assert out["clean_false_positive_rate"] == 0.0


def test_coverage():
    assert coverage([1.0, 2.0, 3.0, 0.5], floor=2.0) == 0.5
```

- [ ] **Step 2: Run to verify failure**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_metrics.py -v`
Expected: FAIL with `ModuleNotFoundError: spikes_srv36_metrics` / `metrics`.

- [ ] **Step 3: Implement the helpers**

```python
# server/tts-sidecar/spikes/srv-36/metrics.py
"""Pure measurement helpers for the srv-36 Phase-0 spike. numpy only."""
from __future__ import annotations
import numpy as np


def cosine(a, b) -> float:
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def eer(genuine: list[float], impostor: list[float]) -> dict:
    """Equal-error-rate on cosine scores (higher = more same-speaker).
    Sweeps candidate thresholds; returns the point where the false-accept
    rate (impostor >= thr) equals the false-reject rate (genuine < thr)."""
    g = np.asarray(genuine, dtype=np.float64)
    im = np.asarray(impostor, dtype=np.float64)
    thresholds = np.unique(np.concatenate([g, im, [g.min() - 1e-6, im.max() + 1e-6]]))
    best = {"eer": 1.0, "threshold": 0.0, "gap": 2.0}
    for thr in thresholds:
        far = float(np.mean(im >= thr)) if im.size else 0.0
        frr = float(np.mean(g < thr)) if g.size else 0.0
        gap = abs(far - frr)
        if gap < best["gap"]:
            best = {"eer": (far + frr) / 2.0, "threshold": float(thr), "gap": gap}
    return {"eer": best["eer"], "threshold": best["threshold"]}


def intra_speaker_spread(sims: list[float]) -> dict:
    arr = np.asarray(sims, dtype=np.float64)
    return {
        "mean": float(arr.mean()),
        "std": float(arr.std()),
        "p05": float(np.percentile(arr, 5)),
    }


def residual_value_by_tier(clean: list[float], defects: dict, cutoff: float) -> dict:
    out: dict = {}
    for tier, scores in defects.items():
        s = np.asarray(scores, dtype=np.float64)
        flagged = float(np.mean(s < cutoff)) if s.size else 0.0
        out[tier] = {"flagged_fraction": flagged, "n": int(s.size)}
    c = np.asarray(clean, dtype=np.float64)
    out["clean_false_positive_rate"] = float(np.mean(c < cutoff)) if c.size else 0.0
    out["cutoff"] = float(cutoff)
    return out


def coverage(durations: list[float], floor: float) -> float:
    d = np.asarray(durations, dtype=np.float64)
    return float(np.mean(d >= floor)) if d.size else 0.0
```

- [ ] **Step 4: Run to verify pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_metrics.py -v`
Expected: PASS (all 6 tests). Runs under any Python with numpy — no model needed.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/spikes/srv-36/metrics.py server/tts-sidecar/spikes/srv-36/tests/test_metrics.py
git commit -m "feat(sidecar): srv-36 spike pure metric helpers (cosine/eer/residual-value/coverage)"
```

---

### Task 3: Pure PCM injection transforms

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/inject.py`
- Create: `server/tts-sidecar/spikes/srv-36/tests/test_inject.py`

**Interfaces:**
- Produces (all operate on mono int16-LE `bytes`, return `bytes`):
  - `truncate(pcm, sample_rate, keep_sec) -> bytes`
  - `clip(pcm, ceiling=0.6) -> bytes` (hard-clip to ±ceiling of full-scale — a deterministic "harsh/garbled" proxy)
  - `reverse_span(pcm, sample_rate, start_sec, dur_sec) -> bytes`
  - `splice(pcm_a, pcm_b, sample_rate, at_sec) -> bytes` (insert `pcm_b` into `pcm_a` at `at_sec`)
- Consumed by: `run_e1.py` (constructed-garble defect class).

- [ ] **Step 1: Write the failing tests**

```python
# server/tts-sidecar/spikes/srv-36/tests/test_inject.py
import numpy as np
from spikes_srv36_inject import truncate, clip, reverse_span, splice

SR = 16000


def _ramp(n):  # deterministic, distinguishable samples
    return (np.linspace(-30000, 30000, n)).astype("<i2").tobytes()


def test_truncate_keeps_only_requested_seconds():
    pcm = _ramp(SR)  # 1.0 s
    out = truncate(pcm, SR, 0.25)
    assert len(out) == int(SR * 0.25) * 2  # int16 = 2 bytes/sample


def test_clip_bounds_amplitude():
    pcm = _ramp(SR)
    out = np.frombuffer(clip(pcm, ceiling=0.5), dtype="<i2")
    assert out.max() <= int(0.5 * 32767) + 1
    assert out.min() >= -int(0.5 * 32767) - 1


def test_reverse_span_changes_only_the_span():
    pcm = _ramp(SR)
    out = reverse_span(pcm, SR, start_sec=0.0, dur_sec=0.5)
    a = np.frombuffer(pcm, dtype="<i2")
    b = np.frombuffer(out, dtype="<i2")
    half = SR // 2
    assert np.array_equal(b[:half], a[:half][::-1])  # first half reversed
    assert np.array_equal(b[half:], a[half:])         # rest untouched


def test_splice_lengthens_by_inserted_clip():
    a = _ramp(SR)
    b = _ramp(SR // 2)
    out = splice(a, b, SR, at_sec=0.5)
    assert len(out) == len(a) + len(b)
```

- [ ] **Step 2: Run to verify failure**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_inject.py -v`
Expected: FAIL with import error for `inject`.

- [ ] **Step 3: Implement the transforms**

```python
# server/tts-sidecar/spikes/srv-36/inject.py
"""Deterministic PCM corruption transforms — the 'constructed garble' defect
class for srv-36 E1 (spec §2.0). Mono int16-LE bytes in/out. numpy only."""
from __future__ import annotations
import numpy as np


def _arr(pcm: bytes):
    return np.frombuffer(pcm, dtype="<i2").copy()


def truncate(pcm: bytes, sample_rate: int, keep_sec: float) -> bytes:
    a = _arr(pcm)
    return a[: int(sample_rate * keep_sec)].astype("<i2").tobytes()


def clip(pcm: bytes, ceiling: float = 0.6) -> bytes:
    a = _arr(pcm).astype(np.int32)
    lim = int(ceiling * 32767)
    return np.clip(a, -lim, lim).astype("<i2").tobytes()


def reverse_span(pcm: bytes, sample_rate: int, start_sec: float, dur_sec: float) -> bytes:
    a = _arr(pcm)
    s = int(sample_rate * start_sec)
    e = min(len(a), s + int(sample_rate * dur_sec))
    a[s:e] = a[s:e][::-1]
    return a.astype("<i2").tobytes()


def splice(pcm_a: bytes, pcm_b: bytes, sample_rate: int, at_sec: float) -> bytes:
    a = _arr(pcm_a)
    b = _arr(pcm_b)
    at = int(sample_rate * at_sec)
    return np.concatenate([a[:at], b, a[at:]]).astype("<i2").tobytes()
```

- [ ] **Step 4: Run to verify pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_inject.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/spikes/srv-36/inject.py server/tts-sidecar/spikes/srv-36/tests/test_inject.py
git commit -m "feat(sidecar): srv-36 spike deterministic PCM garble transforms"
```

---

### Task 4: Fixture render driver (on-box)

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/render_fixture.py`
- Test: covered by `tests/test_aggregates.py` indirectly; the driver itself is on-box I/O (no unit test — its pure parsing helper IS tested below).

**Interfaces:**
- Produces:
  - `parse_fixture_lines(md: str) -> list[dict]` — PURE: returns `[{"character": str, "text": str}, ...]` for spoken lines (a deliberately simple heuristic — quoted dialogue → nearest preceding speaker; narration → `"Narrator"`). Tested.
  - `render_clip(engine_name: str, voice: str, text: str) -> tuple[bytes, int]` — on-box: returns `(pcm, sample_rate)` from the real sidecar engine. Wraps the engines already in `main.py`.
  - `build_clips() -> dict` — on-box: writes `results/clips_manifest.json` mapping `character -> {reference: path, lines: [{path, dur_sec, engine, voice}]}` and the raw PCM under `results/clips/`.
- Consumed by: every `run_eN.py` driver.

- [ ] **Step 1: Write the failing test for the pure parser**

```python
# add to server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py  (new file; more added in Task 5+)
from spikes_srv36_render_fixture import parse_fixture_lines  # noqa


def test_parse_fixture_lines_attributes_quotes_to_speaker():
    md = (
        "# Chapter One\n\n"
        "Tam Hollis leaned in.\n\n"
        '"We move at dawn," said Tam.\n\n'
        '"Not if I see you first," Wren shot back.\n'
    )
    lines = parse_fixture_lines(md)
    spoken = [l for l in lines if l["text"].startswith(("We move", "Not if"))]
    assert spoken[0]["character"] == "Tam"
    assert spoken[1]["character"] == "Wren"
    assert all(l["text"] for l in lines)  # no empty lines
```

- [ ] **Step 2: Run to verify failure**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py -v`
Expected: FAIL importing `render_fixture`.

- [ ] **Step 3: Implement the driver (pure parser + on-box render)**

```python
# server/tts-sidecar/spikes/srv-36/render_fixture.py
"""On-box: render the canonical fixture through the real sidecar engines.
Run from a GPU box with the sidecar venv. The parser is pure + tested."""
from __future__ import annotations
import json, os, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
CLIPS = RESULTS / "clips"
FIXTURE = HERE.parents[2] / "src" / "__fixtures__" / "the-coalfall-commission.md"

# Hand-mapped cast voices for the spike (Kokoro presets + which character is Qwen-designed).
# Stratified preset pairs for E2/E1 are derived from these. Edit on-box to match the
# fixture's real roster if it drifts.
CAST = {
    "Narrator": {"engine": "kokoro", "voice": "bm_george"},
    "Tam":      {"engine": "kokoro", "voice": "am_adam"},
    "Wren":     {"engine": "kokoro", "voice": "af_heart"},
    # near-miss partner for Wren (same gender/accent) used by E2/E1 'subtle' tier:
    "_NEARMISS": {"Wren": "af_bella"},
    # a Qwen-designed character to exercise the forced-fallback defect:
    "Maerin":   {"engine": "qwen", "voice": "maerin"},
}

_SPEAKER = re.compile(r'(?:said|asked|shot back|replied|called)\s+([A-Z][a-z]+)')


def parse_fixture_lines(md: str) -> list[dict]:
    out: list[dict] = []
    last_speaker = "Narrator"
    for raw in md.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.search(r'"([^"]+)"', line)
        if m:
            tag = _SPEAKER.search(line)
            speaker = tag.group(1) if tag else last_speaker
            last_speaker = speaker
            out.append({"character": speaker, "text": m.group(1)})
        else:
            out.append({"character": "Narrator", "text": line})
    return out


def render_clip(engine_name: str, voice: str, text: str):
    # Import the real engines from the sidecar package.
    sys.path.insert(0, str(HERE.parents[1]))  # server/tts-sidecar
    from main import ENGINES  # the synth engine registry
    engine = ENGINES[engine_name]
    pcm = engine.synthesize(voice, text)            # bytes (mono int16-LE)
    sr = getattr(engine, "sample_rate", 24000)
    return pcm, sr


def _dur_sec(pcm: bytes, sr: int) -> float:
    return len(pcm) / 2 / sr


def build_clips() -> dict:
    CLIPS.mkdir(parents=True, exist_ok=True)
    lines = parse_fixture_lines(FIXTURE.read_text(encoding="utf-8"))
    manifest: dict = {}
    for ln in lines:
        ch = ln["character"]
        cfg = CAST.get(ch) or CAST["Narrator"]
        pcm, sr = render_clip(cfg["engine"], cfg["voice"], ln["text"])
        slot = manifest.setdefault(ch, {"engine": cfg["engine"], "voice": cfg["voice"],
                                        "reference": None, "lines": []})
        idx = len(slot["lines"])
        p = CLIPS / f"{ch}-{idx}.pcm"
        p.write_bytes(pcm)
        slot["lines"].append({"path": str(p), "dur_sec": _dur_sec(pcm, sr),
                              "sr": sr, "engine": cfg["engine"], "voice": cfg["voice"]})
    # Reference = the longest line per character (proxy for the audition sample).
    for ch, slot in manifest.items():
        if slot["lines"]:
            slot["reference"] = max(slot["lines"], key=lambda l: l["dur_sec"])["path"]
    (RESULTS / "clips_manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


if __name__ == "__main__":
    m = build_clips()
    print(f"rendered {sum(len(v['lines']) for v in m.values())} clips for {len(m)} characters")
```

- [ ] **Step 4: Run to verify the parser test passes**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py -v`
Expected: PASS for `test_parse_fixture_lines_attributes_quotes_to_speaker` (pure; no engine needed).

- [ ] **Step 5: (On-box only) smoke-run the render driver**

Run on a GPU box: `server/tts-sidecar/.venv/Scripts/python.exe -m spikes.srv-36.render_fixture` (or `cd` into the dir and `python render_fixture.py`).
Expected: prints `rendered N clips for M characters`; `results/clips_manifest.json` + `results/clips/*.pcm` exist. If the engine API differs from `engine.synthesize(voice, text)`, adjust `render_clip` to match `main.py`'s real signature (it is the one place this spike touches engine internals).

- [ ] **Step 6: Commit (code only — do NOT commit the large PCM clips)**

```bash
printf 'clips/\nclips_manifest.json\n' > server/tts-sidecar/spikes/srv-36/results/.gitignore
git add server/tts-sidecar/spikes/srv-36/render_fixture.py server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py server/tts-sidecar/spikes/srv-36/results/.gitignore
git commit -m "feat(sidecar): srv-36 spike fixture render driver + pure line parser"
```

---

### Task 5: E1 — residual-value experiment

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/run_e1.py`
- Modify: `server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py` (add E1 aggregate tests)

**Interfaces:**
- Consumes: `embed_pcm`, `metrics.residual_value_by_tier`, `metrics.eer`, the clip manifest, `inject.*`.
- Produces:
  - `aggregate_e1(clean_sims, defect_sims_by_tier, cutoff) -> dict` — PURE wrapper that adds a `subtle_clears` boolean (subtle flagged_fraction ≥ 0.60 AND clean FP ≤ 0.10). Tested.
  - on-box `main()` → writes `results/e1.json` with per-tier residual value for the three injectable defect classes mapped to tiers (forced-fallback→{near=subtle,far=gross}; wrong-preset→{nearmiss=subtle,distant=gross}; garble→gross).
- Consumed by: `synthesize.py`.

- [ ] **Step 1: Write the failing aggregate test**

```python
# append to server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py
from spikes_srv36_run_e1 import aggregate_e1


def test_aggregate_e1_subtle_gate():
    # subtle clears: 2/3 flagged (>=0.60) and clean FP 0 (<=0.10)
    a = aggregate_e1([0.95, 0.96, 0.94], {"subtle": [0.80, 0.78, 0.97], "gross": [0.2, 0.3]}, 0.85)
    assert a["subtle_clears"] is True
    # subtle fails the gate when only 1/3 flagged
    b = aggregate_e1([0.95, 0.96], {"subtle": [0.80, 0.97, 0.98], "gross": [0.2]}, 0.85)
    assert b["subtle_clears"] is False
```

- [ ] **Step 2: Run to verify failure**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py::test_aggregate_e1_subtle_gate -v`
Expected: FAIL importing `run_e1`.

- [ ] **Step 3: Implement E1**

```python
# server/tts-sidecar/spikes/srv-36/run_e1.py
"""E1 — residual value: do same-config defects separate from clean renders?
Pure aggregate is unit-tested; main() is the on-box driver."""
from __future__ import annotations
import json
from pathlib import Path

from metrics import residual_value_by_tier

SUBTLE_FLAG_BAR = 0.60   # spec §2.1 proposed bar; judged on the SUBTLE tier only
CLEAN_FP_CEILING = 0.10

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def aggregate_e1(clean_sims, defect_sims_by_tier, cutoff) -> dict:
    rv = residual_value_by_tier(clean_sims, defect_sims_by_tier, cutoff)
    subtle = rv.get("subtle", {}).get("flagged_fraction", 0.0)
    rv["subtle_clears"] = bool(
        subtle >= SUBTLE_FLAG_BAR and rv["clean_false_positive_rate"] <= CLEAN_FP_CEILING
    )
    rv["bars"] = {"subtle_flag": SUBTLE_FLAG_BAR, "clean_fp_ceiling": CLEAN_FP_CEILING}
    return rv


def main():  # on-box
    from embed import embed_pcm
    from metrics import eer
    import inject
    manifest = json.loads((RESULTS / "clips_manifest.json").read_text())

    def emb(path):
        sr = 24000
        return embed_pcm(Path(path).read_bytes(), sr)

    # Clean: each non-reference line vs its character's reference.
    clean, subtle, gross = [], [], []
    from numpy import dot  # cosine via normalised dot (embeddings are unit-norm)
    for ch, slot in manifest.items():
        if not slot["reference"]:
            continue
        ref = emb(slot["reference"])
        for ln in slot["lines"]:
            if ln["path"] == slot["reference"]:
                continue
            clean.append(float(dot(ref, emb(ln["path"]))))
            # GROSS garble: clip the same clean PCM and re-score.
            garbled = inject.clip(Path(ln["path"]).read_bytes(), 0.4)
            gross.append(float(dot(ref, embed_pcm(garbled, ln["sr"]))))
    # Subtle/gross fallback + preset defects are produced by the on-box operator
    # re-rendering specific lines per the CAST near-miss map and appending here.
    # (Documented in README; left as explicit on-box steps so the numbers are real.)
    out = aggregate_e1(clean, {"subtle": subtle, "gross": gross}, cutoff=_pick_cutoff(clean))
    out["in_domain_eer_clean_vs_gross"] = eer(genuine=clean, impostor=gross)
    (RESULTS / "e1.json").write_text(json.dumps(out, indent=2))
    print("E1:", out["subtle_clears"], json.dumps(out["bars"]))


def _pick_cutoff(clean):
    # Cutoff anchored below the clean cluster (E2 refines this); 5th percentile.
    import numpy as np
    return float(np.percentile(clean, 5)) if clean else 0.5


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify the aggregate test passes**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py::test_aggregate_e1_subtle_gate -v`
Expected: PASS.

- [ ] **Step 5: (On-box) run E1 and produce real numbers**

Run on the GPU box after `render_fixture.py`: `python run_e1.py`. Then follow `README.md` to append the **subtle-tier** defects: re-render Wren's lines with `af_bella` (near-miss preset) and Maerin's lines forced through Kokoro (fallback, reference stays Qwen), embedding each vs the clean reference and adding to the `subtle` list before the final write. Confirm `results/e1.json` has non-empty `subtle` with `n ≥ 10`.

- [ ] **Step 6: Commit (code + committed e1.json)**

```bash
git add server/tts-sidecar/spikes/srv-36/run_e1.py server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py
# On-box, also: git add -f server/tts-sidecar/spikes/srv-36/results/e1.json
git commit -m "feat(sidecar): srv-36 spike E1 residual-value experiment"
```

---

### Task 6: E2 — separability + in-domain EER + preset near-miss

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/run_e2.py`
- Modify: `server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py`

**Interfaces:**
- Produces:
  - `aggregate_e2(intra_sims, inter_sims, nearmiss_sims) -> dict` — PURE: `{intra: spread, eer_inter, eer_nearmiss, nearmiss_separable: bool}` where `nearmiss_separable` = EER(intra vs nearmiss) < 0.30. Tested.
  - on-box `main()` → `results/e2.json`.
- Consumed by: `synthesize.py`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_aggregates.py
from spikes_srv36_run_e2 import aggregate_e2


def test_aggregate_e2_flags_nearmiss_separability():
    out = aggregate_e2(
        intra_sims=[0.93, 0.94, 0.92],
        inter_sims=[0.10, 0.15, 0.05],
        nearmiss_sims=[0.55, 0.60, 0.58],
    )
    assert out["intra"]["mean"] > 0.9
    assert out["eer_inter"]["eer"] == 0.0       # different characters: separable
    assert out["nearmiss_separable"] in (True, False)
    assert 0.0 <= out["eer_nearmiss"]["eer"] <= 1.0
```

- [ ] **Step 2: Run to verify failure**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py::test_aggregate_e2_flags_nearmiss_separability -v`
Expected: FAIL importing `run_e2`.

- [ ] **Step 3: Implement E2**

```python
# server/tts-sidecar/spikes/srv-36/run_e2.py
"""E2 — separability & in-domain EER. Is the SAME voice tight, and are
same-gender near-miss presets even separable from it?"""
from __future__ import annotations
import json
from pathlib import Path
from metrics import intra_speaker_spread, eer

NEARMISS_EER_BAR = 0.30
HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def aggregate_e2(intra_sims, inter_sims, nearmiss_sims) -> dict:
    eer_near = eer(genuine=intra_sims, impostor=nearmiss_sims)
    return {
        "intra": intra_speaker_spread(intra_sims),
        "eer_inter": eer(genuine=intra_sims, impostor=inter_sims),
        "eer_nearmiss": eer_near,
        "nearmiss_separable": bool(eer_near["eer"] < NEARMISS_EER_BAR),
        "bar": {"nearmiss_eer": NEARMISS_EER_BAR},
    }


def main():  # on-box
    from embed import embed_pcm
    from numpy import dot
    manifest = json.loads((RESULTS / "clips_manifest.json").read_text())

    def emb(p):
        return embed_pcm(Path(p).read_bytes(), 24000)

    intra, inter = [], []
    refs = {ch: emb(s["reference"]) for ch, s in manifest.items() if s["reference"]}
    for ch, slot in manifest.items():
        if ch not in refs:
            continue
        for ln in slot["lines"]:
            e = emb(ln["path"])
            intra.append(float(dot(refs[ch], e)))
            for other, oref in refs.items():
                if other != ch:
                    inter.append(float(dot(oref, e)))
    # nearmiss: operator re-renders the near-miss-preset clips (CAST['_NEARMISS'])
    # and appends similarities-vs-own-reference here per README.
    nearmiss: list[float] = []
    out = aggregate_e2(intra, inter, nearmiss)
    (RESULTS / "e2.json").write_text(json.dumps(out, indent=2))
    print("E2:", json.dumps(out["intra"]), "nearmiss_separable=", out["nearmiss_separable"])


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify the aggregate test passes**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py::test_aggregate_e2_flags_nearmiss_separability -v`
Expected: PASS.

- [ ] **Step 5: (On-box) run E2** — `python run_e2.py`; append near-miss clips per README; confirm `results/e2.json` has non-empty `intra` and `nearmiss`.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv-36/run_e2.py server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py
git commit -m "feat(sidecar): srv-36 spike E2 separability + in-domain EER"
```

---

### Task 7: E3 — clip-length variance + coverage

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/run_e3.py`
- Modify: `server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py`

**Interfaces:**
- Produces:
  - `aggregate_e3(length_to_sims: dict[float, list[float]], char_durations: list[float], floor: float) -> dict` — PURE: per-length cosine std (vs the 5 s embedding), the `min_scorable_sec` (smallest length whose std ≤ 0.05), and `character_coverage` at the floor. Tested.
  - on-box `main()` → `results/e3.json`.
- Consumed by: `synthesize.py`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_aggregates.py
from spikes_srv36_run_e3 import aggregate_e3


def test_aggregate_e3_picks_floor_and_coverage():
    out = aggregate_e3(
        length_to_sims={0.5: [0.6, 0.9, 0.7], 2.0: [0.97, 0.98, 0.96], 5.0: [1.0, 1.0, 1.0]},
        char_durations=[0.5, 1.0, 3.0, 4.0],
        floor=2.0,
    )
    assert out["min_scorable_sec"] == 2.0     # 0.5 s is too noisy, 2.0 s is stable
    assert out["character_coverage"] == 0.5   # 2 of 4 >= 2.0 s
```

- [ ] **Step 2: Run to verify failure**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py::test_aggregate_e3_picks_floor_and_coverage -v`
Expected: FAIL importing `run_e3`.

- [ ] **Step 3: Implement E3**

```python
# server/tts-sidecar/spikes/srv-36/run_e3.py
"""E3 — clip length vs embedding stability, and realistic checked-coverage."""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np
from metrics import coverage

STD_OK = 0.05
HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def aggregate_e3(length_to_sims: dict, char_durations: list, floor: float) -> dict:
    per_len = {float(k): float(np.std(v)) for k, v in length_to_sims.items()}
    scorable = sorted(L for L, s in per_len.items() if s <= STD_OK)
    return {
        "std_by_length": per_len,
        "min_scorable_sec": (scorable[0] if scorable else None),
        "character_coverage": coverage(char_durations, floor),
        "floor": floor,
        "std_ok": STD_OK,
    }


def main():  # on-box
    from embed import embed_pcm
    from numpy import dot
    manifest = json.loads((RESULTS / "clips_manifest.json").read_text())
    lengths = [0.5, 1.0, 2.0, 3.0, 5.0]
    length_to_sims: dict[float, list[float]] = {L: [] for L in lengths}
    char_durs: list[float] = []
    for ch, slot in manifest.items():
        for ln in slot["lines"]:
            if ch != "Narrator":
                char_durs.append(ln["dur_sec"])
            if ln["dur_sec"] < 5.0:
                continue
            pcm = Path(ln["path"]).read_bytes()
            sr = ln["sr"]
            full = embed_pcm(pcm[: int(5.0 * sr) * 2], sr)
            for L in lengths:
                seg = embed_pcm(pcm[: int(L * sr) * 2], sr)
                length_to_sims[L].append(float(dot(full, seg)))
    out = aggregate_e3(length_to_sims, char_durs, floor=2.0)
    (RESULTS / "e3.json").write_text(json.dumps(out, indent=2))
    print("E3: min_scorable_sec=", out["min_scorable_sec"], "coverage=", out["character_coverage"])


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify the aggregate test passes**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py::test_aggregate_e3_picks_floor_and_coverage -v`
Expected: PASS.

- [ ] **Step 5: (On-box) run E3** — `python run_e3.py`; confirm `results/e3.json` reports a `min_scorable_sec` and a `character_coverage` (the headline coverage-honesty number).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv-36/run_e3.py server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py
git commit -m "feat(sidecar): srv-36 spike E3 clip-length floor + coverage"
```

---

### Task 8: E4 — emotion shift (informs Phase 2)

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/run_e4.py`
- Modify: `server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py`

**Interfaces:**
- Produces:
  - `aggregate_e4(cross_emotion_sims, cross_character_sims) -> dict` — PURE: `{emotion_shift_mean, cross_char_mean, emotion_matching_needed: bool}` where needed = the cross-emotion distance is ≥ 50% of the cross-character distance (emotion meaningfully moves the embedding). Tested.
  - on-box `main()` → `results/e4.json`.
- Consumed by: `synthesize.py` (records the Phase-2 signal; does NOT affect the go/no-go).

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_aggregates.py
from spikes_srv36_run_e4 import aggregate_e4


def test_aggregate_e4_flags_emotion_sensitivity():
    needed = aggregate_e4(cross_emotion_sims=[0.6, 0.65], cross_character_sims=[0.2, 0.25])
    # emotion distance (1-0.625=0.375) vs char distance (1-0.225=0.775): 0.375 >= 0.5*0.775? no
    assert needed["emotion_matching_needed"] is False
    needed2 = aggregate_e4(cross_emotion_sims=[0.2], cross_character_sims=[0.1])
    assert needed2["emotion_matching_needed"] is True
```

- [ ] **Step 2: Run to verify failure**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py::test_aggregate_e4_flags_emotion_sensitivity -v`
Expected: FAIL importing `run_e4`.

- [ ] **Step 3: Implement E4**

```python
# server/tts-sidecar/spikes/srv-36/run_e4.py
"""E4 — does emotion move the speaker embedding? (Phase-2 input only.)"""
from __future__ import annotations
import json
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def aggregate_e4(cross_emotion_sims, cross_character_sims) -> dict:
    emo_dist = 1.0 - float(np.mean(cross_emotion_sims))
    char_dist = 1.0 - float(np.mean(cross_character_sims))
    return {
        "emotion_shift_dist": emo_dist,
        "cross_char_dist": char_dist,
        "emotion_matching_needed": bool(emo_dist >= 0.5 * char_dist),
    }


def main():  # on-box — needs a Qwen character rendered in several emotions
    from embed import embed_pcm
    from numpy import dot
    # Operator renders one character's same line in neutral/angry/sad/whisper
    # (Qwen emotion variants) into results/emotions/<emotion>.pcm, plus another
    # character's neutral line, per README. Then:
    edir = RESULTS / "emotions"
    embs = {p.stem: embed_pcm(p.read_bytes(), 24000) for p in edir.glob("*.pcm")}
    neutral = embs.get("neutral")
    cross_emo = [float(dot(neutral, v)) for k, v in embs.items()
                 if k not in ("neutral", "other_char")]
    cross_char = [float(dot(neutral, embs["other_char"]))] if "other_char" in embs else []
    out = aggregate_e4(cross_emo, cross_char)
    (RESULTS / "e4.json").write_text(json.dumps(out, indent=2))
    print("E4: emotion_matching_needed=", out["emotion_matching_needed"])


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run to verify the aggregate test passes**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py::test_aggregate_e4_flags_emotion_sensitivity -v`
Expected: PASS.

- [ ] **Step 5: (On-box) run E4** — render the emotion clips per README, `python run_e4.py`; confirm `results/e4.json`.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv-36/run_e4.py server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py
git commit -m "feat(sidecar): srv-36 spike E4 emotion-shift measurement"
```

---

### Task 9: Findings synthesis + go/no-go recommendation

**Files:**
- Create: `server/tts-sidecar/spikes/srv-36/synthesize.py`
- Create: `server/tts-sidecar/spikes/srv-36/FINDINGS.md` (template; filled by the on-box run)
- Modify: `server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py`

**Interfaces:**
- Consumes: `results/e1.json`..`e4.json`.
- Produces: `decide(e1, e2, e3, e4) -> dict` — PURE: `{recommendation: "go"|"no-go", reasons: [str]}`. **Go** iff `e1.subtle_clears` AND `e2.nearmiss_separable` AND `e3.character_coverage ≥ 0.5`. E4 never affects the recommendation (records a Phase-2 note only). Tested. Plus on-box `write_findings()`.

- [ ] **Step 1: Write the failing decision test**

```python
# append to tests/test_aggregates.py
from spikes_srv36_synthesize import decide


def test_decide_go_requires_subtle_and_nearmiss_and_coverage():
    go = decide(
        e1={"subtle_clears": True}, e2={"nearmiss_separable": True},
        e3={"character_coverage": 0.7}, e4={"emotion_matching_needed": True},
    )
    assert go["recommendation"] == "go"

    nogo = decide(
        e1={"subtle_clears": False}, e2={"nearmiss_separable": True},
        e3={"character_coverage": 0.9}, e4={"emotion_matching_needed": False},
    )
    assert nogo["recommendation"] == "no-go"
    assert any("subtle" in r for r in nogo["reasons"])


def test_decide_recommendation_is_exactly_go_or_nogo():
    out = decide({"subtle_clears": True}, {"nearmiss_separable": False},
                 {"character_coverage": 0.2}, {})
    assert out["recommendation"] in ("go", "no-go")  # never "descope"
```

- [ ] **Step 2: Run to verify failure**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py -k decide -v`
Expected: FAIL importing `synthesize`.

- [ ] **Step 3: Implement the synthesizer**

```python
# server/tts-sidecar/spikes/srv-36/synthesize.py
"""Reads e1..e4 results, renders the go/no-go recommendation (spec §2.1/§2.2)."""
from __future__ import annotations
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
COVERAGE_BAR = 0.50


def decide(e1: dict, e2: dict, e3: dict, e4: dict) -> dict:
    reasons: list[str] = []
    subtle = bool(e1.get("subtle_clears"))
    nearmiss = bool(e2.get("nearmiss_separable"))
    cov_ok = float(e3.get("character_coverage", 0.0)) >= COVERAGE_BAR
    if not subtle:
        reasons.append("E1 subtle-tier defects do not separate from clean renders "
                       "→ acoustic only catches the gross/different-character case "
                       "config-drift already covers.")
    if not nearmiss:
        reasons.append("E2 near-miss presets are not separable → wrong-preset cannot "
                       "be honestly detected.")
    if not cov_ok:
        reasons.append(f"E3 character-segment coverage below {COVERAGE_BAR:.0%} → most "
                       "dialogue would be inconclusive.")
    go = subtle and nearmiss and cov_ok
    if go:
        reasons.append("Subtle same-config defects separate, near-miss is separable, "
                       "and coverage is adequate → acoustic adds real residual value.")
    out = {"recommendation": "go" if go else "no-go", "reasons": reasons}
    if e4.get("emotion_matching_needed"):
        out["phase2_note"] = ("E4: emotion materially shifts the embedding → Phase-2 "
                              "consistency must be per-emotion, not a global centroid.")
    return out


def write_findings() -> dict:  # on-box
    e = {n: json.loads((RESULTS / f"{n}.json").read_text()) for n in ("e1", "e2", "e3", "e4")}
    d = decide(e["e1"], e["e2"], e["e3"], e["e4"])
    md = [
        "# srv-36 Phase 0 — Findings",
        "",
        f"## Recommendation: **{d['recommendation'].upper()}**",
        "",
        *[f"- {r}" for r in d["reasons"]],
        "",
        "## Measured numbers",
        f"- In-domain EER (clean vs gross): `{e['e1'].get('in_domain_eer_clean_vs_gross')}`",
        f"- E1 per-tier residual value: `{json.dumps({k: v for k, v in e['e1'].items() if k in ('subtle','gross','clean_false_positive_rate','subtle_clears')})}`",
        f"- E2 intra-speaker spread: `{e['e2'].get('intra')}` ; near-miss EER: `{e['e2'].get('eer_nearmiss')}`",
        f"- E3 min scorable sec: `{e['e3'].get('min_scorable_sec')}` ; character coverage: `{e['e3'].get('character_coverage')}`",
        f"- E4: `{json.dumps(e['e4'])}`",
        "",
        d.get("phase2_note", ""),
        "",
        "_Calibration anchor = the measured in-domain EER above, NOT VoxCeleb 0.9%._",
    ]
    (HERE / "FINDINGS.md").write_text("\n".join(md), encoding="utf-8")
    return d


if __name__ == "__main__":
    print(write_findings())
```

- [ ] **Step 4: Run to verify the decision tests pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py -k decide -v`
Expected: PASS (3 decide tests).

- [ ] **Step 5: Run the FULL spike test suite**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/spikes/srv-36/tests -v`
Expected: all pure tests PASS; `test_embed.py` PASS or SKIP depending on weights.

- [ ] **Step 6: (On-box) generate FINDINGS.md and commit the deliverable**

Run on the GPU box after E1–E4: `python synthesize.py`. Review `FINDINGS.md`, confirm the recommendation is `go` or `no-go` with measured numbers.

```bash
git add server/tts-sidecar/spikes/srv-36/synthesize.py server/tts-sidecar/spikes/srv-36/tests/test_aggregates.py
git add -f server/tts-sidecar/spikes/srv-36/FINDINGS.md server/tts-sidecar/spikes/srv-36/results/e1.json server/tts-sidecar/spikes/srv-36/results/e2.json server/tts-sidecar/spikes/srv-36/results/e3.json server/tts-sidecar/spikes/srv-36/results/e4.json
git commit -m "feat(sidecar): srv-36 phase-0 findings + go/no-go recommendation"
```

- [ ] **Step 7: Act on the recommendation (spec §2.2 / §8)**

- On **no-go**: comment the FINDINGS recommendation + numbers on #665; close it `wont-fix-acoustic`; mark the spec `superseded`; confirm fs-51 (#973) is unaffected. Record the §2.3 decision on the config-drift `25/40` cuts (retire-as-placeholder or re-file).
- On **go**: open the srv-36 Phase-1 plan (separate planning session, seeded by the measured EER / floor / coverage). Update #665 `type:chore → type:feature`.

---

## Self-Review

**Spec coverage (Phase 0 only — Phase 1/2 are out of scope by design):**
- §2.0 injectable defects → Task 3 (garble) + Task 4/5 on-box (fallback, preset). ✓
- §2 E1–E4 → Tasks 5–8. ✓
- §2.1 subtle-tier gate + measured anchor → `aggregate_e1` subtle_clears + E2 EER + `decide`. ✓
- §2.2 `{go|no-go}` only, no descope → `decide` + `test_decide_recommendation_is_exactly_go_or_nogo`. ✓
- §2.3 #665 literal ask → Task 9 Step 7. ✓
- §0.2 fs-51 decoupling → Task 9 Step 7 (no-go branch confirms unaffected). ✓
- Throwaway / no production code → File Structure confined to `spikes/srv-36/`. ✓
- R2 anchor = in-domain EER not VoxCeleb → E1/E2 EER + FINDINGS footer. ✓
- R3 coverage honesty → E3 `character_coverage`. ✓

**Placeholder scan:** the on-box experiment steps intentionally require an operator to append the fallback/near-miss/emotion re-renders (the defects that can only be produced by re-rendering, not transformed) — these are explicit, mechanism-specified on-box actions documented in README, not vague TODOs. All pure helpers have complete code + tests.

**Type consistency:** `embed_pcm(pcm, sr)->ndarray`, `cosine`, `eer(...)->{eer,threshold}`, `residual_value_by_tier(...)->{tier:{flagged_fraction,n}, clean_false_positive_rate, cutoff}`, `aggregate_eN`, `decide(e1,e2,e3,e4)->{recommendation,reasons}` are used consistently across tasks and tests.

---

## Notes for the implementer

- **Tasks 1–3, the aggregate/decide halves of 5–9, and Task 4's parser are fully TDD'd and run anywhere** (numpy/pytest). Do these first; they need no GPU.
- **The on-box experiment runs (Task 4 Step 5; Tasks 5–8 Step 5; Task 9 Step 6) require a GPU box** with the sidecar venv + `speechbrain` + the engines, and produce the committed `results/*.json` + `FINDINGS.md`. They are the measurement, not unit tests.
- `render_clip` / `ENGINES` is the one place the spike touches `main.py` internals — verify the real engine method signature on-box and adjust (the rest of the spike depends only on `(pcm, sample_rate)` tuples).
- If `speechbrain`'s import path differs in the pinned version, fix `load_encoder` (`speechbrain.inference.speaker.EncoderClassifier` is the 1.0+ path; `speechbrain.pretrained` is pre-1.0).
