# srv-36 Phase 2 — Voice-Consistency Spike (the gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on real on-box Qwen series renders, whether a persistent per-voice ECAPA canonical can detect **cross-book** voice drift that survives controlling for text content, the stochastic floor, and emotion — and emit a **pre-registered, per-axis `{go|no-go}`** that gates whether the Phase-2 build (canonical store + cross-book scoring) is ever written.

**Architecture:** A throwaway extension of the existing Phase-0/1 spike package at `server/tts-sidecar/spikes/srv36/`. New pure measurement helpers (numpy, TDD'd) compute the cross-book experiments **G0–G6**; on-box steps run them against the real Keeper-of-the-Lost-Cities renders (the only ≥2-book Qwen series on disk) and a blinded operator-listen set. Thresholds are **committed before any measurement runs** (pre-registration). The deliverable is an appended `FINDINGS.md` section with each axis's go/no-go evaluated against the committed thresholds. **No production code, no settings, no events.**

**Tech Stack:** Python 3.11/3.12, pytest, numpy, SpeechBrain ECAPA-TDNN (`spkrec-ecapa-voxceleb`, CPU); the real generation pipeline + sidecar `/embed`. Reuses `metrics.py` (`cosine`, `centroid`, `eer`, `spread_stats`), `embed.py` (`embed_pcm`), `probe_real_library.py`, `gates.py`.

## Global Constraints

- **This is the GATE, not the build.** Everything here is throwaway research under `server/tts-sidecar/spikes/srv36/`. No changes to `main.py`/server/registry/events. The Phase-2 *build* (canonical store, §3.5 concurrency contract, scoring, classifier) gets its **own plan, written only after this spike returns cross-book = go** — because the build's cutoffs, K, Branch-A-vs-B choice, and which axes ship are *outputs of this spike* (spec §2, §9.1).
- **Cross-book is Qwen-only** (spec §0): the collision-free key is the Qwen `voiceUuid`. Coqui (shared catalog speakers) and Kokoro (deterministic) are out of scope here.
- **On-box data reality (spec §1, §2):** **Keeper of the Lost Cities (7 books) is the only ≥2-book Qwen series on disk.** Skulduggery (Scepter) and Night Watch are single books. So G1/G2/G6 are **single-series**; the Branch-B sanity-gate band ships **provisional**.
- **Legacy keying caveat (spec §2 C2):** on-disk renders predate `voiceUuid`, so `qwenStorageKey` resolves to `qwen-<voiceId>` (e.g. `qwen-sophie`). The spike validates the **legacy key**; the `matchedFrom`→`voiceUuid` carry (`hydrate-reused-voice.ts:110`) is **assumed equivalent unless re-rendered through the voiceUuid path**. The findings note must state which key was exercised.
- **Pre-registration is non-negotiable (spec §2 C4):** G1/G6 numeric thresholds are committed to a tracked file **before** any measurement. Phase-1's `FINDINGS.md` records a pre-registered gate discarded mid-spike — do not repeat. A mid-spike threshold change is a logged protocol amendment, never a silent swap.
- **G0 same-text control is a prerequisite (spec §2 C1):** ECAPA per-segment embeddings vary with phonetic content. The genuine cross-book signal is cross-book distance **minus the G0 same-text floor**. No G1 number is interpretable without G0.
- **Per-character-relative, never a global absolute cutoff** (Phase-1 proved the absolute floor is wide, std 0.09–0.14; only per-character-relative cutoffs separate drift).
- **G5 is BLIND (spec §2 C5):** flagged + matched clips interleaved, randomized, unlabelled; FP/FN scored against the blind key; a second listener on a subset where feasible.
- **Recommendation is exactly one `{go|no-go}` PER AXIS** (cross-book / maturation / per-emotion / wander). Cross-book may go while wander no-goes.
- **Tests:** direct pytest from the sidecar root, NOT `npm run test:sidecar`: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests -v`. Model/weights-dependent steps SKIP+exit-0 when the venv/weights are absent.
- All audio mono int16-LE; ECAPA wants 16 kHz float — resample at embed time (`embed.py` already does this).

---

## File Structure

`srv36` is a valid package; modules import as `spikes.srv36.X`.

| File | Responsibility |
|---|---|
| Create `spikes/srv36/crossbook.py` | New pure helpers: same-text floor (G0), per-character-relative cross-book drift (G1), seed divergence + spread (G2), and the pre-registered go/no-go evaluator. numpy-only, no I/O. |
| Create `spikes/srv36/crossbook_thresholds.json` | The **pre-registered** G1/G6 numeric thresholds + go-conditions. Committed before any measurement (Task 1). |
| Create `spikes/srv36/crossbook_run.py` | On-box driver: walks Keeper renders via `probe_real_library`, builds per-(storage-key, book) centroids, calls the `crossbook` helpers, writes `results/crossbook_*.json`. Operator-run, not unit-tested. |
| Create `spikes/srv36/blind_listen.py` | Builds the blinded G5 clip set (interleaved/randomized/unlabelled) + scores collected labels into FP/FN. Pure builder + scorer TDD'd; clip extraction reuses `extract_listen.py`. |
| Create `spikes/srv36/tests/test_crossbook.py` | Unit tests for every `crossbook.py` helper + the go/no-go evaluator. |
| Create `spikes/srv36/tests/test_blind_listen.py` | Unit tests for the blind-set builder + FP/FN scorer. |
| Modify `spikes/srv36/FINDINGS.md` | Append the Phase-2 cross-book section: per-axis measurements + `{go|no-go}` vs the committed thresholds. |
| Reuse `metrics.py`, `embed.py`, `gates.py`, `probe_real_library.py` | cosine/centroid/eer/spread, ECAPA embed, gate labels, library walk — unchanged. |

---

## Task 1: Pre-register thresholds + the go/no-go evaluator (C4)

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/crossbook_thresholds.json`
- Create: `server/tts-sidecar/spikes/srv36/crossbook.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Produces: `evaluate_axes(measured: dict, thresholds: dict) -> dict` — maps measured stats to `{ "cross_book": "go"|"no-go", "maturation": ..., "per_emotion": ..., "wander": ... }`, comparing **only** against the passed-in (committed) thresholds. Later tasks fill `measured`.

- [ ] **Step 1: Write the pre-registered thresholds file**

```json
{
  "_comment": "PRE-REGISTERED 2026-06-22 before any Phase-2 measurement. Changing a value mid-spike requires a logged amendment in FINDINGS.md, not a silent edit.",
  "g0_max_same_text_floor": 0.10,
  "g1_max_drift_above_g0_ratio": 0.5,
  "g1_min_per_char_separation": 0.15,
  "g6_min_separation_auc": 0.80,
  "g2_material_divergence": 0.08,
  "g3_material_emotion_shift": 0.08,
  "g4_min_wander_slope": 0.02,
  "g4_min_residual_fraction": 0.20
}
```

- [ ] **Step 2: Write the failing test for the evaluator**

```python
# tests/test_crossbook.py
import pytest
from spikes.srv36.crossbook import evaluate_axes

THRESH = {
    "g0_max_same_text_floor": 0.10, "g1_max_drift_above_g0_ratio": 0.5,
    "g1_min_per_char_separation": 0.15, "g6_min_separation_auc": 0.80,
    "g2_material_divergence": 0.08, "g3_material_emotion_shift": 0.08,
    "g4_min_wander_slope": 0.02, "g4_min_residual_fraction": 0.20,
}

def test_cross_book_go_requires_all_of_g0_g1_g6():
    measured = {"g0_same_text_floor": 0.05, "g1_drift_above_g0_ratio": 0.7,
                "g1_per_char_separation": 0.22, "g6_separation_auc": 0.88}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "go"

def test_loose_g1_cannot_be_rescued_by_g6():
    # g1 ratio below the required 0.5 → no-go regardless of a great g6
    measured = {"g0_same_text_floor": 0.05, "g1_drift_above_g0_ratio": 0.3,
                "g1_per_char_separation": 0.22, "g6_separation_auc": 0.99}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "no-go"

def test_large_g0_floor_kills_cross_book():
    measured = {"g0_same_text_floor": 0.20, "g1_drift_above_g0_ratio": 0.9,
                "g1_per_char_separation": 0.30, "g6_separation_auc": 0.95}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "no-go"

def test_axes_are_independent():
    measured = {"g0_same_text_floor": 0.05, "g1_drift_above_g0_ratio": 0.7,
                "g1_per_char_separation": 0.22, "g6_separation_auc": 0.88,
                "g4_wander_slope": 0.001, "g4_residual_fraction": 0.05}
    out = evaluate_axes(measured, THRESH)
    assert out["cross_book"] == "go" and out["wander"] == "no-go"
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: FAIL — `ImportError: cannot import name 'evaluate_axes'`.

- [ ] **Step 4: Implement the evaluator**

```python
# spikes/srv36/crossbook.py
"""Pure cross-book measurement helpers for the srv-36 Phase-2 spike. numpy only."""
from __future__ import annotations
import numpy as np
from spikes.srv36.metrics import cosine, centroid


def evaluate_axes(measured: dict, thresholds: dict) -> dict:
    t = thresholds
    cross_book = (
        measured.get("g0_same_text_floor", 1.0) <= t["g0_max_same_text_floor"]
        and measured.get("g1_drift_above_g0_ratio", 0.0) >= t["g1_max_drift_above_g0_ratio"]
        and measured.get("g1_per_char_separation", 0.0) >= t["g1_min_per_char_separation"]
        and measured.get("g6_separation_auc", 0.0) >= t["g6_min_separation_auc"]
    )
    maturation = measured.get("g2_divergence", 0.0) >= t["g2_material_divergence"]
    per_emotion = measured.get("g3_emotion_shift", 0.0) >= t["g3_material_emotion_shift"]
    wander = (
        measured.get("g4_wander_slope", 0.0) >= t["g4_min_wander_slope"]
        and measured.get("g4_residual_fraction", 0.0) >= t["g4_min_residual_fraction"]
    )
    return {
        "cross_book": "go" if cross_book else "no-go",
        "maturation": "go" if maturation else "no-go",
        "per_emotion": "go" if per_emotion else "no-go",
        "wander": "go" if wander else "no-go",
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_thresholds.json \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py
git commit -m "test(sidecar): pre-register srv-36 Phase-2 cross-book go/no-go thresholds + evaluator"
```

---

## Task 2: On-box library probe — confirm Keeper ≥2 Qwen books + record keying (C2/C3)

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Reuse: `server/tts-sidecar/spikes/srv36/probe_real_library.py`

**Interfaces:**
- Produces: `results/crossbook_inventory.json` — `{ series: [{ name, books: [{bookId, slug}], storage_keys: [{key, key_kind: "voiceId"|"voiceUuid", recurs_in_books: [...]}] }] }`. Consumed by Tasks 3–8.

This task is **operator-run on the GPU box** (reads the real library); it has no unit test of its own (it reads live artifacts). It produces the inventory that proves the §1/§2 data reality before any measurement is trusted.

- [ ] **Step 1: Write the inventory driver**

```python
# spikes/srv36/crossbook_run.py  (inventory portion)
"""On-box driver for the Phase-2 cross-book spike. Operator-run; reads real renders."""
from __future__ import annotations
import json, sys
from pathlib import Path
from spikes.srv36.probe_real_library import iter_series_books  # existing walk

def build_inventory(books_root: str) -> dict:
    series = {}
    for s in iter_series_books(books_root):  # yields {series, bookId, slug, segments_path}
        series.setdefault(s["series"], {"name": s["series"], "books": [], "keys": {}})
        series[s["series"]]["books"].append({"bookId": s["bookId"], "slug": s["slug"]})
        for seg in json.loads(Path(s["segments_path"]).read_text("utf-8")).get("segments", []):
            key = seg.get("storageKey") or seg.get("characterId")  # legacy fallback
            if not key:
                continue
            kind = "voiceUuid" if str(key).startswith("qwen-") and "-" in str(key)[5:] and len(str(key)) > 20 else "voiceId"
            series[s["series"]]["keys"].setdefault(key, {"key": key, "key_kind": kind, "recurs_in_books": set()})
            series[s["series"]]["keys"][key]["recurs_in_books"].add(s["bookId"])
    # serialise sets
    out = {"series": []}
    for sv in series.values():
        keys = [{**k, "recurs_in_books": sorted(k["recurs_in_books"])} for k in sv["keys"].values()]
        out["series"].append({"name": sv["name"], "books": sv["books"], "storage_keys": keys})
    return out

if __name__ == "__main__":
    inv = build_inventory(sys.argv[1])
    Path("spikes/srv36/results/crossbook_inventory.json").write_text(json.dumps(inv, indent=2), "utf-8")
    for s in inv["series"]:
        multi = [k for k in s["storage_keys"] if len(k["recurs_in_books"]) >= 2]
        print(f"{s['name']}: {len(s['books'])} books, {len(multi)} keys recurring in >=2 books")
```

> Note: if `iter_series_books` does not yet exist in `probe_real_library.py`, add a thin generator there that walks `BOOKS_ROOT` and yields one dict per rendered book (`series`, `bookId`, `slug`, `segments_path`) — it mirrors the existing per-book walk that file already does for Phase 0/1.

- [ ] **Step 2: Run on-box and confirm the data reality**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.crossbook_run <BOOKS_ROOT>`
Expected: a line per series; **confirm Keeper shows ≥2 books with ≥1 recurring key**, and note each key's `key_kind`. If only `voiceId` keys appear, record the C2 caveat (legacy keying validated, not voiceUuid).

- [ ] **Step 3: Commit the driver + inventory**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/probe_real_library.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_inventory.json
git commit -m "feat(sidecar): srv-36 Phase-2 cross-book inventory probe (confirms Keeper-only, records keying)"
```

---

## Task 3: G0 — same-text content control (C1 prerequisite)

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/crossbook.py`
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Produces: `same_text_floor(per_book_audition_embeddings: list[np.ndarray]) -> float` — given the embedding of the **identical audition text** rendered once per book's config, returns the mean pairwise cross-book cosine **distance** (1 − cosine). This is the content-free timbre floor.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_crossbook.py
import numpy as np
from spikes.srv36.crossbook import same_text_floor

def test_same_text_floor_zero_for_identical():
    e = np.array([0.6, 0.8, 0.0])
    assert same_text_floor([e, e, e]) == pytest.approx(0.0, abs=1e-9)

def test_same_text_floor_grows_with_divergence():
    a = np.array([1.0, 0.0]); b = np.array([0.0, 1.0])
    assert same_text_floor([a, a, b]) > 0.2
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py::test_same_text_floor_zero_for_identical -v`
Expected: FAIL — `cannot import name 'same_text_floor'`.

- [ ] **Step 3: Implement**

```python
# append to spikes/srv36/crossbook.py
def same_text_floor(per_book_audition_embeddings) -> float:
    embs = [np.asarray(e, np.float64) for e in per_book_audition_embeddings]
    if len(embs) < 2:
        return 0.0
    dists = [1.0 - cosine(embs[i], embs[j])
             for i in range(len(embs)) for j in range(i + 1, len(embs))]
    return float(np.mean(dists))
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS.

- [ ] **Step 5: Wire the on-box measurement into `crossbook_run.py`**

Add a function that, for each recurring storage key in the inventory, re-renders the character's **audition text** once in each Keeper book's config (via the sidecar `/embed` over a fresh synth, reusing `synthesize.py` + `embed.py`), then calls `same_text_floor`. Write the per-key floors + the cast-wide mean to `results/crossbook_g0.json`.

```python
# crossbook_run.py — measurement (operator-run)
from spikes.srv36.crossbook import same_text_floor
from spikes.srv36.embed import embed_pcm
# for each key: pcm_per_book = [synth(audition_text, cfg_for_book) for book in books]
#   embs = [embed_pcm(pcm, sr) for pcm, sr in pcm_per_book]
#   floors[key] = same_text_floor(embs)
```

- [ ] **Step 6: Run on-box + record**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.crossbook_run <BOOKS_ROOT> --g0`
Expected: `results/crossbook_g0.json` written; **record the cast-wide same-text floor** — if it exceeds `g0_max_same_text_floor` (0.10), ECAPA is too content-sensitive here → cross-book no-go (stop and record).

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g0.json
git commit -m "feat(sidecar): srv-36 Phase-2 G0 same-text content control"
```

---

## Task 4: G1 — cross-book stability, per-character-relative, drift-above-G0

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/crossbook.py`
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Consumes: `same_text_floor` (Task 3), `centroid`/`cosine` (metrics.py).
- Produces: `crossbook_drift(per_book_clean_embeddings: dict[int, list], g0_floor: float) -> dict` — builds each book's per-key centroid, returns `{ "drift_above_g0": float (mean cross-book centroid distance minus g0_floor), "per_char_separation": float }`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_crossbook.py
from spikes.srv36.crossbook import crossbook_drift

def test_crossbook_drift_subtracts_g0_floor():
    # two books, near-identical clean renders → centroid distance ~ g0 floor → drift ~0
    bookA = [np.array([1.0, 0.0]), np.array([0.99, 0.01])]
    bookB = [np.array([0.98, 0.02]), np.array([1.0, 0.0])]
    out = crossbook_drift({1: bookA, 2: bookB}, g0_floor=0.0)
    assert out["drift_above_g0"] < 0.05

def test_crossbook_drift_detects_a_shifted_book():
    bookA = [np.array([1.0, 0.0]), np.array([1.0, 0.0])]
    bookB = [np.array([0.0, 1.0]), np.array([0.0, 1.0])]  # whole book shifted
    out = crossbook_drift({1: bookA, 2: bookB}, g0_floor=0.0)
    assert out["drift_above_g0"] > 0.5
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py::test_crossbook_drift_subtracts_g0_floor -v`
Expected: FAIL — `cannot import name 'crossbook_drift'`.

- [ ] **Step 3: Implement**

```python
# append to spikes/srv36/crossbook.py
def crossbook_drift(per_book_clean_embeddings: dict, g0_floor: float) -> dict:
    book_centroids = [centroid(embs) for embs in per_book_clean_embeddings.values() if len(embs)]
    if len(book_centroids) < 2:
        return {"drift_above_g0": 0.0, "per_char_separation": 0.0}
    dists = [1.0 - cosine(book_centroids[i], book_centroids[j])
             for i in range(len(book_centroids)) for j in range(i + 1, len(book_centroids))]
    drift = float(np.mean(dists)) - g0_floor
    return {"drift_above_g0": max(0.0, drift), "per_char_separation": float(np.max(dists) - np.min(dists))}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS.

- [ ] **Step 5: Wire the on-box measurement**

In `crossbook_run.py --g1`: for each recurring key, slice the **clean (gate-passing, per `gates.is_gate_flagged`)** per-segment PCM from each Keeper book, embed, group by book, call `crossbook_drift` with the Task-3 floor. Aggregate the per-character ratio (`drift_above_g0 / g0_floor`) and the per-char separation. Write `results/crossbook_g1.json`.

- [ ] **Step 6: Run on-box + record vs the pre-registered threshold**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.crossbook_run <BOOKS_ROOT> --g1`
Expected: record `g1_drift_above_g0_ratio` and `g1_per_char_separation`; compare to the committed `crossbook_thresholds.json` (do NOT adjust the threshold to fit).

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g1.json
git commit -m "feat(sidecar): srv-36 Phase-2 G1 cross-book stability (per-char, drift-above-G0)"
```

---

## Task 5: G2 — seed divergence + per-voice cross-book spread

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/crossbook.py`
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Produces: `seed_divergence(audition_centroid, per_book_centroids: list) -> dict` — `{ "central": mean(1−cosine(audition, book)), "spread": std of those per-book divergences }`. `central` drives Branch A-vs-B; `spread` sets the provisional sanity-gate band.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_crossbook.py
from spikes.srv36.crossbook import seed_divergence

def test_seed_divergence_zero_when_audition_matches_books():
    aud = np.array([1.0, 0.0])
    out = seed_divergence(aud, [np.array([1.0, 0.0]), np.array([0.99, 0.01])])
    assert out["central"] < 0.02 and out["spread"] < 0.02

def test_seed_divergence_reports_spread_across_books():
    aud = np.array([1.0, 0.0])
    out = seed_divergence(aud, [np.array([1.0, 0.0]), np.array([0.0, 1.0])])
    assert out["central"] > 0.3 and out["spread"] > 0.3
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py::test_seed_divergence_zero_when_audition_matches_books -v`
Expected: FAIL — `cannot import name 'seed_divergence'`.

- [ ] **Step 3: Implement**

```python
# append to spikes/srv36/crossbook.py
def seed_divergence(audition_centroid, per_book_centroids) -> dict:
    aud = np.asarray(audition_centroid, np.float64)
    divs = [1.0 - cosine(aud, np.asarray(c, np.float64)) for c in per_book_centroids]
    if not divs:
        return {"central": 0.0, "spread": 0.0}
    return {"central": float(np.mean(divs)), "spread": float(np.std(divs))}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS.

- [ ] **Step 5: Wire on-box + run + record**

In `crossbook_run.py --g2`: per recurring key, embed the approved audition (K renders, K from `audition-centroid.ts` = 12), build its centroid, and the per-book clean centroids (Task 4); call `seed_divergence`; write `results/crossbook_g2.json`. Run on-box; record `central` (→ Branch A vs B) and `spread` (→ provisional sanity-gate band). **Mark the band single-series/provisional** in the output (only Keeper).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g2.json
git commit -m "feat(sidecar): srv-36 Phase-2 G2 seed divergence + per-voice spread"
```

---

## Task 6: G6 — runtime-operation fidelity on a held-out Keeper book (I1)

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Consumes: `metrics.eer` (existing), the Task-4 per-book anchor.
- Produces: `results/crossbook_g6.json` — separation AUC/EER of **individual held-out-book line cosines** (genuine = same key, impostor = other keys) scored against the **anchor built from the OTHER books** (out-of-sample vs G1).

- [ ] **Step 1: Write the failing test (separation metric)**

```python
# append to tests/test_crossbook.py
from spikes.srv36.crossbook import separation_auc

def test_separation_auc_perfect():
    assert separation_auc([0.9, 0.95, 0.92], [0.1, 0.2, 0.15]) == pytest.approx(1.0)

def test_separation_auc_chance():
    auc = separation_auc([0.5, 0.5], [0.5, 0.5])
    assert 0.4 <= auc <= 0.6
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py::test_separation_auc_perfect -v`
Expected: FAIL — `cannot import name 'separation_auc'`.

- [ ] **Step 3: Implement**

```python
# append to spikes/srv36/crossbook.py
def separation_auc(genuine, impostor) -> float:
    g = np.asarray(genuine, np.float64); im = np.asarray(impostor, np.float64)
    if not g.size or not im.size:
        return 0.5
    wins = sum(float(np.sum(gi > im)) + 0.5 * float(np.sum(gi == im)) for gi in g)
    return float(wins / (g.size * im.size))
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS.

- [ ] **Step 5: Wire on-box + run + record**

In `crossbook_run.py --g6`: hold out one Keeper book; build each key's anchor from the **remaining** books; score every held-out-book line's cosine to its own-key anchor (genuine) vs to other keys' anchors (impostor); call `separation_auc`. Write `results/crossbook_g6.json`; record `g6_separation_auc` vs the committed threshold (0.80).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g6.json
git commit -m "feat(sidecar): srv-36 Phase-2 G6 held-out runtime-op separability"
```

---

## Task 7: G3 — per-emotion shift (neutral-tagged baseline, M3)

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Produces: `results/crossbook_g3.json` — for each base key, `1 − cosine(neutral-tagged centroid, emotional-line centroid)`. The neutral centroid is built from **manuscript emotion-metadata `neutral`** lines, NOT merely gate-OK lines.

- [ ] **Step 1: Write the failing test (emotion-shift metric)**

```python
# append to tests/test_crossbook.py
from spikes.srv36.crossbook import emotion_shift

def test_emotion_shift_zero_when_same():
    neutral = [np.array([1.0, 0.0]), np.array([0.99, 0.01])]
    emotional = [np.array([1.0, 0.0])]
    assert emotion_shift(neutral, emotional) < 0.02

def test_emotion_shift_positive_when_timbre_moves():
    neutral = [np.array([1.0, 0.0])]
    emotional = [np.array([0.0, 1.0])]
    assert emotion_shift(neutral, emotional) > 0.5
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py::test_emotion_shift_zero_when_same -v`
Expected: FAIL — `cannot import name 'emotion_shift'`.

- [ ] **Step 3: Implement**

```python
# append to spikes/srv36/crossbook.py
def emotion_shift(neutral_embeddings, emotional_embeddings) -> float:
    if not len(neutral_embeddings) or not len(emotional_embeddings):
        return 0.0
    return float(1.0 - cosine(centroid(neutral_embeddings), centroid(emotional_embeddings)))
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS.

- [ ] **Step 5: Wire on-box + run + record**

In `crossbook_run.py --g3`: split each base key's clean lines by the manuscript `emotion` tag (`neutral` vs non-neutral); build the neutral centroid only from `neutral`-tagged lines; call `emotion_shift`. Write `results/crossbook_g3.json`. Record `g3_emotion_shift`; if ≥ threshold (0.08) → **partial no-go** (emotional base-voice lines `inconclusive`, per spec §4.3) — record, do not "tune away."

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g3.json
git commit -m "feat(sidecar): srv-36 Phase-2 G3 per-emotion shift (neutral-tagged baseline)"
```

---

## Task 8: G4 — temporal wander existence + residual (likely no-go)

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Produces: `results/crossbook_g4.json` — within-book monotonic slope of cosine-to-anchor over render position + the fraction of wander cases NOT already flagged by per-line/cross-book.

> **Prior (spec §2): probably no-go** — a single config renders the voice near-identically, so monotonic intra-book wander is a priori unlikely to clear the floor AND be non-redundant. Do not over-invest; one measurement pass suffices.

- [ ] **Step 1: Write the failing test (slope metric)**

```python
# append to tests/test_crossbook.py
from spikes.srv36.crossbook import wander_slope

def test_wander_slope_flat_for_stable_voice():
    assert abs(wander_slope([0.9, 0.9, 0.9, 0.9])) < 0.01

def test_wander_slope_negative_for_drifting_voice():
    assert wander_slope([0.95, 0.85, 0.75, 0.65]) < -0.05
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py::test_wander_slope_flat_for_stable_voice -v`
Expected: FAIL — `cannot import name 'wander_slope'`.

- [ ] **Step 3: Implement**

```python
# append to spikes/srv36/crossbook.py
def wander_slope(cosines_in_render_order) -> float:
    y = np.asarray(cosines_in_render_order, np.float64)
    if y.size < 2:
        return 0.0
    x = np.arange(y.size, dtype=np.float64)
    return float(np.polyfit(x, y, 1)[0])  # slope
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS.

- [ ] **Step 5: Wire on-box + run + record**

In `crossbook_run.py --g4`: per key per book, order clean-line cosines-to-anchor by render position, call `wander_slope`; cross-reference which slope-flagged lines were NOT already per-line/cross-book flagged (residual). Write `results/crossbook_g4.json`. Record `g4_wander_slope` + `g4_residual_fraction`.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g4.json
git commit -m "feat(sidecar): srv-36 Phase-2 G4 temporal-wander measurement"
```

---

## Task 9: G5 — blinded operator-listen harness (C5)

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/blind_listen.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_blind_listen.py`
- Reuse: `server/tts-sidecar/spikes/srv36/extract_listen.py` (clip extraction)

**Interfaces:**
- Produces: `build_blind_set(flagged: list[dict], matched: list[dict], seed: int) -> tuple[list[dict], dict]` — returns `(presentation, answer_key)` where `presentation` is the interleaved, deterministically-shuffled, **label-stripped** clip list and `answer_key` maps clip-id → `"flagged"|"matched"`. And `score_blind(answer_key: dict, operator_labels: dict) -> dict` → `{ "fp": int, "fn": int, "fp_rate": float, "fn_rate": float }`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_blind_listen.py
import pytest
from spikes.srv36.blind_listen import build_blind_set, score_blind

def test_build_blind_set_strips_labels_and_is_deterministic():
    flagged = [{"id": "f1"}, {"id": "f2"}]
    matched = [{"id": "m1"}, {"id": "m2"}]
    pres1, key1 = build_blind_set(flagged, matched, seed=42)
    pres2, key2 = build_blind_set(flagged, matched, seed=42)
    assert [c["id"] for c in pres1] == [c["id"] for c in pres2]   # deterministic
    assert all("label" not in c and "is_flagged" not in c for c in pres1)  # blind
    assert set(key1) == {"f1", "f2", "m1", "m2"} and key1["f1"] == "flagged"

def test_score_blind_counts_fp_fn():
    key = {"f1": "flagged", "f2": "flagged", "m1": "matched", "m2": "matched"}
    # operator says: f1 drift (correct), f2 clean (FN), m1 drift (FP), m2 clean (correct)
    labels = {"f1": "drift", "f2": "clean", "m1": "drift", "m2": "clean"}
    out = score_blind(key, labels)
    assert out["fn"] == 1 and out["fp"] == 1
    assert out["fn_rate"] == pytest.approx(0.5) and out["fp_rate"] == pytest.approx(0.5)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_blind_listen.py -v`
Expected: FAIL — `No module named 'spikes.srv36.blind_listen'`.

- [ ] **Step 3: Implement**

```python
# spikes/srv36/blind_listen.py
"""Blinded G5 operator-listen set builder + scorer (C5). Deterministic, label-free."""
from __future__ import annotations
import random


def build_blind_set(flagged, matched, seed: int):
    answer_key, pool = {}, []
    for c in flagged:
        answer_key[c["id"]] = "flagged"; pool.append({"id": c["id"]})
    for c in matched:
        answer_key[c["id"]] = "matched"; pool.append({"id": c["id"]})
    random.Random(seed).shuffle(pool)   # deterministic interleave
    return pool, answer_key


def score_blind(answer_key: dict, operator_labels: dict) -> dict:
    fp = fn = n_flagged = n_matched = 0
    for cid, truth in answer_key.items():
        op = operator_labels.get(cid)
        if truth == "flagged":
            n_flagged += 1
            if op == "clean":
                fn += 1            # real drift the operator heard as clean
        else:
            n_matched += 1
            if op == "drift":
                fp += 1            # clean clip the operator heard as drift
    return {"fp": fp, "fn": fn,
            "fp_rate": fp / n_matched if n_matched else 0.0,
            "fn_rate": fn / n_flagged if n_flagged else 0.0}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_blind_listen.py -v`
Expected: PASS.

- [ ] **Step 5: Operator step — extract clips, listen blind, record labels**

Build the presentation set from the G1/G6-flagged keys + an equal number of matched (high-cosine) controls; extract each clip via `extract_listen.py`; the operator listens **without seeing `answer_key`**, writing `clip-id → drift|clean` into `results/crossbook_g5_labels.json`; a second listener does a subset where feasible. Then `score_blind(answer_key, labels)` → `results/crossbook_g5.json`.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/blind_listen.py \
        server/tts-sidecar/spikes/srv36/tests/test_blind_listen.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g5*.json
git commit -m "feat(sidecar): srv-36 Phase-2 G5 blinded operator-listen harness"
```

---

## Task 10: Compile FINDINGS — per-axis go/no-go vs the committed thresholds

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/FINDINGS.md`
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`

- [ ] **Step 1: Assemble the measured dict + evaluate**

Add a `--report` mode to `crossbook_run.py` that loads `results/crossbook_g{0,1,2,3,4,5,6}.json`, assembles the `measured` dict (keys matching Task 1's `evaluate_axes`), loads `crossbook_thresholds.json`, calls `evaluate_axes`, and prints the per-axis verdict.

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.crossbook_run --report`
Expected: prints `{cross_book, maturation, per_emotion, wander}` each `go|no-go`.

- [ ] **Step 2: Append the Phase-2 section to FINDINGS.md**

Append a `## Phase 2 — cross-book consistency` section recording, verbatim: the **pre-registered thresholds**; the measured G0–G6 numbers; the **keying exercised** (voiceId vs voiceUuid, C2); the **single-series Keeper** caveat (C3); the **blind** G5 FP/FN (C5); and the **per-axis `{go|no-go}`** from `evaluate_axes`. If any threshold was amended mid-spike, log the amendment + rationale here (C4).

- [ ] **Step 3: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/FINDINGS.md \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/results/
git commit -m "docs(sidecar): srv-36 Phase-2 spike FINDINGS — per-axis go/no-go"
```

- [ ] **Step 4: Decide + record the downstream**

- **cross-book = no-go** → close Phase 2 `wont-fix-consistency`; mark the design spec `superseded`; confirm fs-51 unaffected. **Stop — no build plan.**
- **cross-book = go** → write the **Phase-2 build plan** (Waves 1–5 per design-spec §9.1), now parameterised by the spike's measured cutoffs/K/branch/axes. The build is a separate plan + separate branch.

---

## What this plan deliberately does NOT cover (deferred until the spike returns go)

The build waves (design-spec §9.1) are **out of this plan** because their parameters are this spike's outputs:
- **Wave 1** — storage-key + config-hash persistence (`segments-io.ts`), the canonical store, the **§3.5 concurrency contract** (storage-key lock + read-merge-write + re-score-the-loser + rotate backups), Branch-A anchor, cross-book scoring, events.
- **Wave 2** — Branch B (maturation + sanity-gated freeze + re-score + visible consistency pass), only if G2 material.
- **Wave 3** — three-way classifier + auto-repair wiring + com-1 seam.
- **Wave 4** — fs-51 consumption + calibration + Ship notes.
- **Wave 5** — temporal-wander detector, only if G4 = go.

Each wave's plan is written when its gating axis returns go, with the spike's measured numbers filled in (no placeholders).

## Self-Review

- **Spec coverage:** every spike experiment in design-spec §2 (G0–G6) + the pre-registration (C4), keying caveat (C2), single-series caveat (C3), blind listen (C5), neutral-tagged G3 (M3), held-out G6 (I1) maps to a task here. The build (§3–§8) is explicitly deferred above, gated on this spike. ✓
- **Placeholders:** none — every pure helper has real test + implementation code; on-box steps have exact commands. ✓
- **Type consistency:** `evaluate_axes` keys (`g0_same_text_floor`, `g1_drift_above_g0_ratio`, `g1_per_char_separation`, `g6_separation_auc`, `g2_divergence`, `g3_emotion_shift`, `g4_wander_slope`, `g4_residual_fraction`) match the metric functions' outputs and the `crossbook_thresholds.json` keys. The on-box `--report` mode (Task 10) assembles exactly those keys. ✓
