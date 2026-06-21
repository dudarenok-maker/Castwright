# srv-36 Phase 0 — Stochastic-Drift Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on real Qwen + Coqui (stochastic) output, whether an ECAPA speaker-embedding check can catch the model's own **drift** (a correctly-configured voice rendering wrong) — specifically drift that the **existing ASR + audio-QA gates miss** — and emit a committed `{go|no-go}` recommendation that gates whether srv-36 Phase 1 is ever built.

**Architecture:** A throwaway Python **package** at `server/tts-sidecar/spikes/srv36/`, run in the sidecar venv (+`speechbrain`). The fixture book is **over-generated M times through the real pipeline** with the ASR + audio-QA gates ON, producing, per run, chapter audio + a `segments.json` carrying the **real per-segment gate verdicts**. The Python spike reads those artifacts: it slices per-segment PCM, embeds with ECAPA, builds a per-character **centroid** from clean renders, scores every segment's cosine-to-centroid, and computes F1 (stochastic floor + centroid size K), F3 (separability of real misfires above the floor), F4 (**residual value** — drift acoustic flags that the gates missed; human-confirmed), F5 (length/coverage). Pure helpers are TDD'd; the on-box analysis reads real artifacts. **No production code, no settings, no synthetic injection.**

**Tech Stack:** Python 3.11/3.12, pytest, numpy, SpeechBrain ECAPA-TDNN (`spkrec-ecapa-voxceleb`); the real generation pipeline for the over-generation runs.

## Global Constraints

- **Throwaway/committed-for-reproducibility, NOT production.** No changes to `main.py`/server, no settings, no events. Everything under `server/tts-sidecar/spikes/srv36/`.
- **Drift is non-deterministic (spec §1).** Engines under test are the **stochastic** ones — **Qwen and Coqui XTTS**. **Kokoro is excluded** (deterministic → cannot drift). The over-generation runs use whatever stochastic engine(s) the fixture's designed voices support.
- **Real labels, not injection (spec §2).** The "is this render bad" labels come from the **existing gates' per-segment verdicts** already written into `segments.json` during generation (`asr` = `AsrClassification.verdict`, plus the per-segment `qa`/`suspect` signal-QA flags). The spike never fabricates a defect.
- **Over-generation is required.** Real drift appears only at volume → generate the fixture book **M times** (M ≥ 10 to start; more is better) with `SEG_ASR_ENABLED=1` and audio-QA on. Each run re-renders stochastically.
- **Reference is a CENTROID** (spec §2.0/§3.3): per character, the mean (re-normalised) embedding of its **clean** (gate-passing) renders across runs. Centroid size K is an F1 output.
- **The gate is F4** (spec §2.1): acoustic must flag real drift that **ASR + audio-QA missed**, human-confirmed. Re-flagging only what the gates already catch = redundant = **no-go**. F1 (floor too wide) and F3 (can't separate) are earlier no-go exits.
- **Calibration anchor = measured in-domain EER** (F3), never VoxCeleb 0.9%.
- **Recommendation is exactly one of `{go, no-go}`.**
- **Tests:** direct pytest, NOT `npm run test:sidecar` (the spike dir is not on that gate path by design). Run from the sidecar root so imports resolve: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests -v`. Model-dependent tests SKIP+exit-0 when weights/venv absent.
- All audio mono int16-LE; ECAPA wants 16 kHz float — resample at embed time (`torchaudio.functional.resample`; not `.load`, so no FFmpeg dependency).

---

## File Structure

`srv36` is a valid package. Modules import as `spikes.srv36.X`.

| File | Responsibility |
|---|---|
| `spikes/__init__.py`, `spikes/srv36/__init__.py`, `spikes/srv36/tests/__init__.py` | package markers |
| `spikes/srv36/README.md` | on-box run guide: designed voices, the M-run over-generation command, analysis, F4 listening |
| `spikes/srv36/embed.py` | ECAPA load + `embed_pcm(pcm, sr) -> np.ndarray` (192-dim, L2-normalised) |
| `spikes/srv36/metrics.py` | PURE: `cosine`, `eer`, `centroid`, `spread_stats`, `coverage` |
| `spikes/srv36/segments_io.py` | PURE: `load_segments(path)`, `seg_key(seg)`, `slice_pcm(pcm, sr, start_sec, end_sec)` |
| `spikes/srv36/gates.py` | PURE: `is_gate_flagged(seg) -> bool` (existing ASR + signal-QA verdicts) |
| `spikes/srv36/aggregates.py` | PURE: `f1_floor`, `f3_separability`, `f5_length_coverage`, `residual_value` |
| `spikes/srv36/synthesize.py` | PURE: `decide(f1, f3, f4, f5)` + on-box `write_findings()` |
| `spikes/srv36/analyze.py` | on-box: read M runs → centroids, per-segment cosine, label join → `results/*.json` + exports F4 listen-set |
| `spikes/srv36/tests/*.py` | pytest for embed / metrics / segments_io / gates / aggregates / decide |
| `spikes/srv36/results/.gitignore` | ignores `clips/`, `runs/` (large audio) |
| `spikes/srv36/FINDINGS.md` | committed deliverable (go/no-go + measured numbers) |

**Tooling:** `PY="server/tts-sidecar/.venv/Scripts/python.exe"`. Pure tests run anywhere with numpy/pytest.

---

### Task 1: Scaffold + ECAPA embed wrapper

**Files:** create `spikes/__init__.py`, `spikes/srv36/__init__.py`, `spikes/srv36/tests/__init__.py` (all empty); `spikes/srv36/results/.gitignore`; `spikes/srv36/embed.py`; `spikes/srv36/tests/conftest.py`; `spikes/srv36/tests/test_embed.py`; `spikes/srv36/README.md`.

**Interfaces:** Produces `embed_pcm(pcm: bytes, sample_rate: int) -> np.ndarray` (192-dim, L2-normalised); `load_encoder()` (cached).

- [ ] **Step 1: `.gitignore` + embed wrapper**

`spikes/srv36/results/.gitignore`:
```
clips/
runs/
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
```

- [ ] **Step 2: conftest + SKIP-gated test**

```python
# server/tts-sidecar/spikes/srv36/tests/conftest.py
import os, sys
_SIDE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _SIDE not in sys.path:
    sys.path.insert(0, _SIDE)
os.environ.setdefault("PRELOAD_COQUI", "0")
os.environ.setdefault("PRELOAD_KOKORO", "0")
```

```python
# server/tts-sidecar/spikes/srv36/tests/test_embed.py
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
```

- [ ] **Step 3: Run** — `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_embed.py -v`. Expected: PASS (weights present) or SKIP.

- [ ] **Step 4: README** — `pip install speechbrain`; the over-generation command (Task 8); analysis (Task 7); the F4 listening step. Note the fixture's designed Qwen/Coqui voices must be in the workspace.

- [ ] **Step 5: Commit** — `git add server/tts-sidecar/spikes/ && git commit -m "feat(sidecar): srv-36 phase-0 stochastic spike scaffold + ECAPA embed"`

---

### Task 2: Pure metric helpers

**Files:** create `spikes/srv36/metrics.py`, `spikes/srv36/tests/test_metrics.py`.

**Interfaces:** `cosine(a,b)->float`; `eer(genuine,impostor)->{"eer","threshold"}`; `centroid(embeddings)->np.ndarray` (mean, re-L2-normalised); `spread_stats(sims)->{"mean","std","p05"}`; `coverage(durations,floor)->float`.

- [ ] **Step 1: Failing tests**

```python
# server/tts-sidecar/spikes/srv36/tests/test_metrics.py
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
```

- [ ] **Step 2: Run to verify failure** — `... -m pytest spikes/srv36/tests/test_metrics.py -v` → FAIL (no module).

- [ ] **Step 3: Implement**

```python
# server/tts-sidecar/spikes/srv36/metrics.py
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
```

- [ ] **Step 4: Run to verify pass** — PASS (5 tests).

- [ ] **Step 5: Commit** — `git add ...metrics.py ...test_metrics.py && git commit -m "feat(sidecar): srv-36 spike pure metric helpers (cosine/eer/centroid/coverage)"`

---

### Task 3: Segment I/O (load real segments.json, slice PCM)

**Files:** create `spikes/srv36/segments_io.py`, `spikes/srv36/tests/test_segments_io.py`.

**Interfaces:**
- `load_segments(path) -> list[dict]` — reads a `<slug>.segments.json`, returns each segment with `character`, `start_sec`, `end_sec`, and the raw `asr`/`qa`/`suspect` fields preserved.
- `seg_key(seg) -> str` — stable id `"{character}:{start_sec:.3f}-{end_sec:.3f}"`.
- `slice_pcm(pcm, sr, start_sec, end_sec) -> bytes` — int16 byte-offset slice (mirrors `chapter-qa-repair.ts` `secToByteOffset`).

- [ ] **Step 1: Failing tests**

```python
# server/tts-sidecar/spikes/srv36/tests/test_segments_io.py
import json, numpy as np
from spikes.srv36.segments_io import load_segments, seg_key, slice_pcm

SR = 16000


def test_load_segments_normalises_fields(tmp_path):
    p = tmp_path / "ch.segments.json"
    p.write_text(json.dumps({"segments": [
        {"characterId": "wren", "startSec": 0.0, "endSec": 1.5,
         "asr": {"verdict": "ok"}, "suspect": False},
    ]}))
    segs = load_segments(str(p))
    assert segs[0]["character"] == "wren"
    assert segs[0]["start_sec"] == 0.0 and segs[0]["end_sec"] == 1.5
    assert segs[0]["asr"]["verdict"] == "ok"


def test_seg_key_stable():
    seg = {"character": "wren", "start_sec": 0.0, "end_sec": 1.5}
    assert seg_key(seg) == "wren:0.000-1.500"


def test_slice_pcm_byte_offsets():
    pcm = (np.arange(SR) % 1000).astype("<i2").tobytes()  # 1.0 s
    out = slice_pcm(pcm, SR, 0.25, 0.5)
    assert len(out) == int(SR * 0.25) * 2  # 0.25 s of int16
```

- [ ] **Step 2: Run to verify failure** — FAIL (no module).

- [ ] **Step 3: Implement**

```python
# server/tts-sidecar/spikes/srv36/segments_io.py
"""Pure readers for the real <slug>.segments.json + PCM slicing."""
from __future__ import annotations
import json


def load_segments(path: str) -> list:
    data = json.loads(open(path, encoding="utf-8").read())
    out = []
    for s in data.get("segments", []):
        out.append({
            "character": s.get("characterId") or s.get("character") or "?",
            "start_sec": float(s.get("startSec", 0.0)),
            "end_sec": float(s.get("endSec", 0.0)),
            "asr": s.get("asr") or {},
            "qa": s.get("qa") or {},
            "suspect": bool(s.get("suspect", False)),
        })
    return out


def seg_key(seg: dict) -> str:
    return f"{seg['character']}:{seg['start_sec']:.3f}-{seg['end_sec']:.3f}"


def slice_pcm(pcm: bytes, sr: int, start_sec: float, end_sec: float) -> bytes:
    s = int(start_sec * sr) * 2
    e = int(end_sec * sr) * 2
    return pcm[s:e]
```

- [ ] **Step 4: Run to verify pass** — PASS (3 tests).

- [ ] **Step 5: Commit** — `git add ...segments_io.py ...test_segments_io.py && git commit -m "feat(sidecar): srv-36 spike segments.json reader + PCM slicing"`

---

### Task 4: Gate labels (the F2 real-misfire labels)

**Files:** create `spikes/srv36/gates.py`, `spikes/srv36/tests/test_gates.py`.

**Interfaces:** `is_gate_flagged(seg) -> bool` — True when the EXISTING gates flagged this segment: `asr.verdict == "drift"` OR `suspect` truthy OR `qa.status == "suspect"`. (`inconclusive`/`ok` are not flags.)

- [ ] **Step 1: Failing tests**

```python
# server/tts-sidecar/spikes/srv36/tests/test_gates.py
from spikes.srv36.gates import is_gate_flagged


def test_flagged_on_asr_drift():
    assert is_gate_flagged({"asr": {"verdict": "drift"}, "qa": {}, "suspect": False}) is True


def test_flagged_on_suspect_or_qa_suspect():
    assert is_gate_flagged({"asr": {}, "qa": {}, "suspect": True}) is True
    assert is_gate_flagged({"asr": {}, "qa": {"status": "suspect"}, "suspect": False}) is True


def test_not_flagged_on_ok_or_inconclusive():
    assert is_gate_flagged({"asr": {"verdict": "ok"}, "qa": {"status": "ok"}, "suspect": False}) is False
    assert is_gate_flagged({"asr": {"verdict": "inconclusive"}, "qa": {}, "suspect": False}) is False
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```python
# server/tts-sidecar/spikes/srv36/gates.py
"""Real per-segment gate labels: did the EXISTING ASR + signal-QA gates flag it?"""
from __future__ import annotations


def is_gate_flagged(seg: dict) -> bool:
    asr = (seg.get("asr") or {}).get("verdict")
    qa = (seg.get("qa") or {}).get("status")
    return asr == "drift" or bool(seg.get("suspect")) or qa == "suspect"
```

- [ ] **Step 4: Run to verify pass** — PASS (3 tests).

- [ ] **Step 5: Commit** — `git add ...gates.py ...test_gates.py && git commit -m "feat(sidecar): srv-36 spike real-gate label extraction"`

---

### Task 5: Pure aggregates (F1 floor, F3 separability, F4 residual, F5 coverage)

**Files:** create `spikes/srv36/aggregates.py`, `spikes/srv36/tests/test_aggregates.py`.

**Interfaces:**
- `f1_floor(clean_sims) -> dict` → `{spread, floor_ok}` (`floor_ok` = std ≤ 0.07 AND p05 ≥ 0.5 — a *tight* correct-voice cluster). Stochastic floor.
- `f3_separability(clean_sims, misfire_sims) -> dict` → `{eer, separable}` (`separable` = eer ≤ 0.25 on the real labels).
- `residual_value(acoustic_flagged_keys, gate_flagged_keys, confirmed_real) -> dict` → `{missed_by_gates, residual_fraction, confirmed_real}` where `missed = acoustic − gate`, `residual_fraction = confirmed_real / max(1, |acoustic_flagged|)`.
- `f5_length_coverage(length_to_sims, seg_durations, floor) -> dict` → `{std_by_length, min_scorable_sec, coverage}`.

- [ ] **Step 1: Failing tests**

```python
# server/tts-sidecar/spikes/srv36/tests/test_aggregates.py
import pytest
from spikes.srv36.aggregates import f1_floor, f3_separability, residual_value, f5_length_coverage


def test_f1_floor_tight_vs_wide():
    assert f1_floor([0.95, 0.96, 0.94, 0.95])["floor_ok"] is True
    assert f1_floor([0.95, 0.40, 0.80, 0.55])["floor_ok"] is False  # wide → swamps drift


def test_f3_separability():
    assert f3_separability([0.95, 0.96], [0.50, 0.55])["separable"] is True
    assert f3_separability([0.80, 0.82], [0.79, 0.81])["separable"] is False


def test_residual_value_is_acoustic_minus_gates():
    out = residual_value(
        acoustic_flagged_keys={"a", "b", "c"},
        gate_flagged_keys={"b"},          # gates only caught b
        confirmed_real=1,                  # human confirmed 1 of {a,c} is real drift
    )
    assert out["missed_by_gates"] == {"a", "c"}
    assert out["residual_fraction"] == pytest.approx(1 / 3)
    assert out["confirmed_real"] == 1


def test_f5_floor_and_coverage():
    out = f5_length_coverage(
        {0.5: [0.6, 0.9], 2.0: [0.97, 0.98], 5.0: [1.0, 1.0]}, [0.5, 3.0], 2.0)
    assert out["min_scorable_sec"] == 2.0
    assert out["coverage"] == 0.5
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```python
# server/tts-sidecar/spikes/srv36/aggregates.py
"""Pure F1/F3/F4/F5 aggregates for the stochastic-drift spike."""
from __future__ import annotations
import numpy as np
from spikes.srv36.metrics import eer, spread_stats

FLOOR_STD_MAX = 0.07
FLOOR_P05_MIN = 0.50
SEP_EER_MAX = 0.25
LEN_STD_OK = 0.05


def f1_floor(clean_sims) -> dict:
    s = spread_stats(clean_sims)
    return {"spread": s, "floor_ok": bool(s["std"] <= FLOOR_STD_MAX and s["p05"] >= FLOOR_P05_MIN)}


def f3_separability(clean_sims, misfire_sims) -> dict:
    e = eer(genuine=clean_sims, impostor=misfire_sims)
    return {"eer": e, "separable": bool(e["eer"] <= SEP_EER_MAX)}


def residual_value(acoustic_flagged_keys, gate_flagged_keys, confirmed_real) -> dict:
    missed = set(acoustic_flagged_keys) - set(gate_flagged_keys)
    denom = max(1, len(set(acoustic_flagged_keys)))
    return {"missed_by_gates": missed, "residual_fraction": confirmed_real / denom,
            "confirmed_real": int(confirmed_real)}


def f5_length_coverage(length_to_sims: dict, seg_durations, floor: float) -> dict:
    per_len = {float(k): float(np.std(v)) for k, v in length_to_sims.items()}
    scorable = sorted(L for L, st in per_len.items() if st <= LEN_STD_OK)
    d = np.asarray(seg_durations, np.float64)
    return {"std_by_length": per_len, "min_scorable_sec": (scorable[0] if scorable else None),
            "coverage": float(np.mean(d >= floor)) if d.size else 0.0}
```

- [ ] **Step 4: Run to verify pass** — PASS (4 tests).

- [ ] **Step 5: Commit** — `git add ...aggregates.py ...test_aggregates.py && git commit -m "feat(sidecar): srv-36 spike pure F1/F3/F4/F5 aggregates"`

---

### Task 6: Decision + findings synthesizer

**Files:** create `spikes/srv36/synthesize.py`; append to `spikes/srv36/tests/test_aggregates.py`.

**Interfaces:** `decide(f1, f3, f4, f5) -> {recommendation: "go"|"no-go", reasons}` — **go** iff `f1.floor_ok` AND `f3.separable` AND `f4.residual_fraction ≥ 0.15` (real drift caught that gates missed) AND `f5.coverage ≥ 0.5`. Plus on-box `write_findings()`.

- [ ] **Step 1: Failing tests**

```python
# append to tests/test_aggregates.py
from spikes.srv36.synthesize import decide


def test_decide_go_requires_all_four():
    go = decide({"floor_ok": True}, {"separable": True},
                {"residual_fraction": 0.3, "confirmed_real": 4}, {"coverage": 0.7})
    assert go["recommendation"] == "go"


def test_decide_nogo_when_no_residual_value():
    nogo = decide({"floor_ok": True}, {"separable": True},
                  {"residual_fraction": 0.0, "confirmed_real": 0}, {"coverage": 0.9})
    assert nogo["recommendation"] == "no-go"
    assert any("residual" in r.lower() or "redundant" in r.lower() for r in nogo["reasons"])


def test_decide_nogo_when_floor_wide():
    out = decide({"floor_ok": False}, {"separable": True},
                 {"residual_fraction": 0.5, "confirmed_real": 5}, {"coverage": 0.9})
    assert out["recommendation"] == "no-go"


def test_decide_is_exactly_go_or_nogo():
    out = decide({"floor_ok": True}, {"separable": False},
                 {"residual_fraction": 0.2, "confirmed_real": 2}, {"coverage": 0.2})
    assert out["recommendation"] in ("go", "no-go")
```

- [ ] **Step 2: Run to verify failure** — FAIL (no `synthesize`).

- [ ] **Step 3: Implement**

```python
# server/tts-sidecar/spikes/srv36/synthesize.py
"""Reads f1..f5 results -> go/no-go (spec §2.1/§2.2). F4 is the decisive gate."""
from __future__ import annotations
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
RESIDUAL_BAR = 0.15
COVERAGE_BAR = 0.50


def decide(f1: dict, f3: dict, f4: dict, f5: dict) -> dict:
    reasons = []
    floor = bool(f1.get("floor_ok"))
    sep = bool(f3.get("separable"))
    resid = float(f4.get("residual_fraction", 0.0)) >= RESIDUAL_BAR
    cov = float(f5.get("coverage", 0.0)) >= COVERAGE_BAR
    if not floor:
        reasons.append("F1 stochastic floor is too wide — a correct voice already scatters "
                       "as much as a misfire; no acoustic check can work.")
    if not sep:
        reasons.append("F3 cannot separate real misfires from clean renders above the floor.")
    if not resid:
        reasons.append(f"F4 residual value below {RESIDUAL_BAR:.0%} — acoustic only re-flags "
                       "what ASR + audio-QA already catch (redundant).")
    if not cov:
        reasons.append(f"F5 coverage below {COVERAGE_BAR:.0%} — most dialogue inconclusive.")
    go = floor and sep and resid and cov
    if go:
        reasons.append("Tight floor, real misfires separable, and acoustic catches drift the "
                       "existing gates miss (human-confirmed) → real residual value.")
    return {"recommendation": "go" if go else "no-go", "reasons": reasons}


def write_findings() -> dict:
    f = {n: json.loads((RESULTS / f"{n}.json").read_text()) for n in ("f1", "f3", "f4", "f5")}
    d = decide(f["f1"], f["f3"], f["f4"], f["f5"])
    md = [
        "# srv-36 Phase 0 — Findings (stochastic drift)", "",
        f"## Recommendation: **{d['recommendation'].upper()}**", "",
        *[f"- {r}" for r in d["reasons"]], "",
        "## Measured numbers",
        f"- F1 stochastic floor: `{f['f1'].get('spread')}` floor_ok=`{f['f1'].get('floor_ok')}`",
        f"- F3 in-domain EER (clean vs REAL misfires): `{f['f3'].get('eer')}` separable=`{f['f3'].get('separable')}`",
        f"- F4 residual value: fraction=`{f['f4'].get('residual_fraction')}` confirmed_real=`{f['f4'].get('confirmed_real')}` (drift the gates missed)",
        f"- F5 min scorable sec / coverage: `{f['f5'].get('min_scorable_sec')}` / `{f['f5'].get('coverage')}`", "",
        "_Anchor = the measured in-domain EER above, NOT VoxCeleb 0.9%._",
    ]
    (HERE / "FINDINGS.md").write_text("\n".join(md), encoding="utf-8")
    return d
```

- [ ] **Step 4: Run to verify pass** — `... -m pytest spikes/srv36/tests/test_aggregates.py -v` → PASS.

- [ ] **Step 5: Run the FULL pure suite** — `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests -v` → all PASS; `test_embed` PASS or SKIP.

- [ ] **Step 6: Commit** — `git add ...synthesize.py ...test_aggregates.py && git commit -m "feat(sidecar): srv-36 spike decision (F4-gated) + findings synthesizer"`

---

### Task 7: On-box analysis driver

**Files:** create `spikes/srv36/analyze.py`.

**Interfaces (on-box; consumes Tasks 2–5):** reads `results/runs/<run>/<slug>.segments.json` + the matching chapter audio (decoded to PCM), builds per-character centroids from **clean** (gate-passing) segments across runs, scores every segment's cosine-to-centroid, joins gate labels, and writes `results/f1.json`, `f3.json`, `f5.json`, plus `results/f4_listen/` (the ECAPA-flagged-but-gate-clean clips for the human step) and `results/f4_pending.json`.

- [ ] **Step 1: Implement the driver**

```python
# server/tts-sidecar/spikes/srv36/analyze.py
"""On-box: turn M over-generation runs into F1/F3/F5 numbers + the F4 listen-set.
Reads real segments.json gate verdicts; embeds real per-segment PCM."""
from __future__ import annotations
import json, wave
from pathlib import Path
import numpy as np

from spikes.srv36.embed import embed_pcm
from spikes.srv36.metrics import cosine, centroid, eer
from spikes.srv36.segments_io import load_segments, seg_key, slice_pcm
from spikes.srv36.gates import is_gate_flagged
from spikes.srv36.aggregates import f1_floor, f3_separability, f5_length_coverage

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
RUNS = RESULTS / "runs"          # runs/<i>/<slug>.segments.json + runs/<i>/<slug>.wav
FLOOR_SEC = 2.0                  # candidate F5 floor; refined by F5 output


def _read_wav(path: Path):
    with wave.open(str(path), "rb") as w:
        return w.readframes(w.getnframes()), w.getframerate()


def _iter_segments():
    """Yield (run, character, key, pcm, sr, dur, flagged) for every segment in every run."""
    for run_dir in sorted(RUNS.glob("*")):
        for segs_path in run_dir.glob("*.segments.json"):
            wavs = list(run_dir.glob(f"{segs_path.stem.split('.')[0]}*.wav"))
            if not wavs:
                continue
            pcm, sr = _read_wav(wavs[0])
            for seg in load_segments(str(segs_path)):
                spcm = slice_pcm(pcm, sr, seg["start_sec"], seg["end_sec"])
                dur = len(spcm) / 2 / sr
                yield (run_dir.name, seg["character"], seg_key(seg), spcm, sr, dur,
                       is_gate_flagged(seg))


def main():
    rows = [r for r in _iter_segments() if r[5] >= FLOOR_SEC]  # scorable only
    # Per-character centroid from CLEAN (gate-passing) renders.
    by_char_clean = {}
    embeds = {}
    for run, ch, key, pcm, sr, dur, flagged in rows:
        e = embed_pcm(pcm, sr); embeds[(run, key)] = (ch, e, flagged, dur)
        if not flagged:
            by_char_clean.setdefault(ch, []).append(e)
    centroids = {ch: centroid(es) for ch, es in by_char_clean.items() if len(es) >= 3}
    K = {ch: len(es) for ch, es in by_char_clean.items()}

    clean_sims, misfire_sims, acoustic_flagged, gate_flagged, durs = [], [], set(), set(), []
    for (run, key), (ch, e, flagged, dur) in embeds.items():
        if ch not in centroids:
            continue
        sim = cosine(centroids[ch], e); durs.append(dur)
        (misfire_sims if flagged else clean_sims).append(sim)
        if flagged:
            gate_flagged.add((run, key))
    # Acoustic flag = cosine below the F3 EER threshold.
    f3 = f3_separability(clean_sims, misfire_sims)
    thr = f3["eer"]["threshold"]
    listen = RESULTS / "f4_listen"; listen.mkdir(parents=True, exist_ok=True)
    for (run, key), (ch, e, flagged, dur) in embeds.items():
        if ch in centroids and cosine(centroids[ch], e) < thr:
            acoustic_flagged.add((run, key))
            if (run, key) not in gate_flagged:   # acoustic-only → the F4 listen-set
                (listen / f"{run}__{key.replace(':','_')}.pcm").write_bytes(
                    slice_pcm(*_clip_for(run, key)))
    (RESULTS / "f1.json").write_text(json.dumps({**f1_floor(clean_sims), "K_per_char": K}, indent=2))
    (RESULTS / "f3.json").write_text(json.dumps(f3, indent=2))
    (RESULTS / "f5.json").write_text(json.dumps(
        f5_length_coverage(_length_sweep(embeds, centroids), durs, FLOOR_SEC), indent=2))
    (RESULTS / "f4_pending.json").write_text(json.dumps({
        "acoustic_flagged": sorted(f"{r}|{k}" for r, k in acoustic_flagged),
        "gate_flagged": sorted(f"{r}|{k}" for r, k in gate_flagged),
        "acoustic_only_to_listen": sorted(f"{r}|{k}" for r, k in (acoustic_flagged - gate_flagged)),
    }, indent=2))
    print(f"F1/F3/F5 written. F4 listen-set: {len(acoustic_flagged - gate_flagged)} clips in {listen}")


# NOTE for the implementer: _clip_for(run, key) and _length_sweep(...) are thin helpers —
# _clip_for re-derives (pcm, sr, start, end) for a (run,key) from the run's segments.json;
# _length_sweep truncates each clean clip to [0.5,1,2,3,5]s and returns {L: [cosine-to-centroid,...]}.
# Both are pure-ish I/O over the same artifacts; implement alongside main() (≈15 lines each).


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: (On-box) implement the two thin helpers** `_clip_for` and `_length_sweep` per the inline note (each re-reads the run's segments.json; `_length_sweep` slices truncations and embeds), then run `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.analyze` after the over-generation (Task 8). Confirm `results/f1.json`, `f3.json`, `f5.json`, `f4_pending.json`, and the `f4_listen/` clips exist.

- [ ] **Step 3: Commit** — `git add server/tts-sidecar/spikes/srv36/analyze.py && git commit -m "feat(sidecar): srv-36 spike on-box analysis driver (centroids + real-label join)"`

---

### Task 8: Over-generation orchestration (on-box, real gates)

**Files:** none new — this task is the documented on-box procedure (in README) that produces `results/runs/`.

- [ ] **Step 1: Document + run the over-generation**

In `README.md`, document and then execute on a GPU box with the fixture's designed Qwen/Coqui voices in the workspace:

1. Set `SEG_ASR_ENABLED=1` (real ASR-QA labels) and confirm audio-QA is on (default advisory).
2. Generate the fixture book **M ≥ 10 times** via the real pipeline (the app's generate path / existing generation route), each run stochastically re-rendering. After each run, copy that run's `<slug>.segments.json` + the rendered chapter audio (as WAV/PCM) into `server/tts-sidecar/spikes/srv36/results/runs/<i>/`.
3. Confirm across runs there are **real gate-flagged segments** (non-empty `asr.verdict=="drift"` / `suspect`) — if zero misfires surfaced, raise M (drift is rare; the gate needs positives to measure F3/F4).

This is the real-misfire harvest (spec F2). It uses the **actual** gates, so F4's "missed by gates" is honest.

- [ ] **Step 2: Sanity-check** — `ls results/runs/*/` shows M runs each with a `.segments.json` + audio. Spot-check one `segments.json` has per-segment `asr`/`suspect` fields populated.

- [ ] **Step 3: Commit the README procedure** (not the large `runs/` audio — gitignored) — `git add server/tts-sidecar/spikes/srv36/README.md && git commit -m "docs(sidecar): srv-36 spike over-generation procedure (real-gate harvest)"`

---

### Task 9: F4 human confirm + findings + act

**Files:** modify `spikes/srv36/synthesize.py` is not needed; this task runs the human step + `write_findings`.

- [ ] **Step 1: (On-box, human) listen to the F4 acoustic-only set**

Play each clip in `results/f4_listen/` (the lines ECAPA flagged that ASR + audio-QA did NOT). For each, judge: is the voice **actually drifted/wrong** (real residual value) or a false positive? Write the count of confirmed-real into `results/f4.json`:

```json
{ "residual_fraction": 0.0, "confirmed_real": 0 }
```
Compute `residual_fraction = confirmed_real / (total acoustic_flagged from f4_pending.json)`. Use `residual_value(...)` from `aggregates.py` to compute it consistently, or fill it by hand from the two counts.

- [ ] **Step 2: Generate FINDINGS.md**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.synthesize`. Review `FINDINGS.md` — recommendation `go`/`no-go` with measured numbers; F4 residual value is the headline.

- [ ] **Step 3: Commit the deliverable**

```bash
git add -f server/tts-sidecar/spikes/srv36/FINDINGS.md \
  server/tts-sidecar/spikes/srv36/results/f1.json \
  server/tts-sidecar/spikes/srv36/results/f3.json \
  server/tts-sidecar/spikes/srv36/results/f4.json \
  server/tts-sidecar/spikes/srv36/results/f5.json \
  server/tts-sidecar/spikes/srv36/results/f4_pending.json
git commit -m "feat(sidecar): srv-36 phase-0 findings + go/no-go recommendation"
```

- [ ] **Step 4: Act on the recommendation (spec §2.2 / §2.3 / §8)**

- **no-go**: comment FINDINGS on #665; close `wont-fix-acoustic`; mark the spec `superseded`; confirm fs-51 (#973) unaffected; record the §2.3 decision on the config-drift `25/40` cuts.
- **go**: open the srv-36 Phase-1 plan (separate session, seeded by the measured floor/EER/K/coverage); update #665 `type:chore → type:feature`.

---

## Self-Review

**Spec coverage (Phase 0):**
- §1 stochastic framing (Qwen/Coqui, Kokoro excluded) → Global Constraints + Task 8 (designed Qwen/Coqui voices, no Kokoro). ✓
- §2.0 centroid reference → `metrics.centroid` (Task 2) + `analyze` builds per-char centroid from clean renders. ✓
- §2 F1 floor → `f1_floor` (Task 5) + analyze. ✓
- F2 real misfires → `gates.is_gate_flagged` (Task 4) + Task 8 over-generation with real gates. ✓
- F3 separability → `f3_separability` (Task 5). ✓
- F4 residual value (the gate) → `residual_value` (Task 5) + analyze's acoustic-only listen-set + Task 9 human confirm + `decide` (Task 6). ✓
- F5 length/coverage → `f5_length_coverage` (Task 5). ✓
- §2.1 go = floor_ok AND separable AND residual ≥ bar AND coverage → `decide`. ✓
- §2.2 `{go|no-go}` only → `decide` + `test_decide_is_exactly_go_or_nogo`. ✓
- §2.3 #665 + §0.2 fs-51 → Task 9 Step 4. ✓
- No synthetic injection → there is no `inject` module; all positives are real gate labels. ✓

**Placeholder scan:** the only operator actions are the on-box over-generation (Task 8), the two thin analyze helpers (Task 7 Step 2, mechanism specified), and the F4 human listen (Task 9) — all explicit. All pure code is complete with tests.

**Type consistency:** `embed_pcm(pcm,sr)->ndarray`, `centroid(embs)->ndarray`, `cosine`, `eer->{eer,threshold}`, `load_segments`/`seg_key`/`slice_pcm`, `is_gate_flagged(seg)->bool`, `f1_floor`/`f3_separability`/`residual_value`/`f5_length_coverage`, `decide(f1,f3,f4,f5)->{recommendation,reasons}` are consistent across tasks and tests.

---

## Notes for the implementer

- **Tasks 1–6 are fully TDD'd and run anywhere** (numpy/pytest, no GPU). Do them first.
- **Tasks 7–9 are on-box** (GPU + sidecar venv + speechbrain + designed Qwen/Coqui voices). Task 8's over-generation is the long pole — real drift is rare, so M must be large enough to surface gate-flagged misfires.
- **The whole point is F4.** F1/F3 are necessary-condition exits; the *decision* is whether acoustic catches real drift the existing ASR + audio-QA gates miss. If the `f4_listen/` set is empty or all false positives → **no-go**, and that is a valid, valuable result.
- If over-generation surfaces too few misfires to measure F3/F4, that itself is informative (drift may be rare enough that the existing gates suffice) — record it; don't fabricate positives.
