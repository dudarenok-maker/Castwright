# srv-36 Phase 2 — Voice-Consistency Spike (the gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on real on-box Qwen series renders, whether a persistent per-voice ECAPA canonical can detect **cross-book** voice drift that survives controlling for text content, the stochastic floor, and emotion — and emit a **pre-registered, per-axis `{go|no-go}`** that gates whether the Phase-2 build (canonical store + cross-book scoring) is ever written.

**Architecture:** A throwaway extension of the existing Phase-0/1 spike package at `server/tts-sidecar/spikes/srv36/`. Because the legacy on-disk renders predate `voiceUuid` and carry no per-book config to replay, the spike first **re-renders a bounded subset through the *current* pipeline** (decision 2026-06-22, spec §2 C2 preferred path): the operator re-casts **2 Keeper-of-the-Lost-Cities books** fresh today (so each recurring character gets a `voiceUuid` carried across both books via series-reuse), then renders **N chapters per book** plus a **fixed per-character audition text rendered K times** (the same-text control). New pure measurement helpers (numpy, TDD'd) then compute **G0–G6** over that fresh, `voiceUuid`-keyed corpus, and a blinded operator-listen set scores G5. **Pre-registered decision rules are committed before any measurement** (fixed bars like the G6 AUC; data-derived quantities like the G0 floor are measured then applied). Deliverable: an appended `FINDINGS.md` with each axis's go/no-go. **No production code, no settings, no events** — the re-render uses the existing app/pipeline as a user would.

**Tech Stack:** Python 3.11/3.12, pytest, numpy, SpeechBrain ECAPA-TDNN (`spkrec-ecapa-voxceleb`, CPU); the real generation pipeline (for book chapters) + the sidecar `/synthesize` HTTP endpoint (for the fixed-text audition control) + `/embed`. Reuses `metrics.py` (`cosine`, `centroid`, `eer`, `spread_stats`), `embed.py` (`embed_pcm`), `gates.py`. **Adds** a `voiceUuid` resolver (join `characterId` → `cast.json`) and a thin sidecar synth client (neither exists today).

## Global Constraints

- **This is the GATE, not the build.** Everything here is throwaway research under `server/tts-sidecar/spikes/srv36/`. No changes to `main.py`/server/registry/events. The Phase-2 *build* (canonical store, §3.5 concurrency contract, scoring, classifier) gets its **own plan, written only after this spike returns cross-book = go** — because the build's cutoffs, K, Branch-A-vs-B choice, and which axes ship are *outputs of this spike* (spec §2, §9.1).
- **Cross-book is Qwen-only** (spec §0): the collision-free key is the Qwen `voiceUuid`. Coqui (shared catalog speakers) and Kokoro (deterministic) are out of scope here.
- **Bounded re-render through the current pipeline (decision 2026-06-22).** The spike does NOT measure from legacy on-disk renders (they predate `voiceUuid`, have no replayable per-book config, and `segments.json` carries no `storageKey` — `segments-io.ts:54`). Instead the operator re-casts + re-renders **2 Keeper books (N chapters each)** today. Cast-carry means both books use the **same `voiceUuid`** per recurring character, so cross-book drift = the stochastic engine rendering *the same configured voice* differently across books — exactly what the canonical would catch.
- **`voiceUuid` is resolved by join, not read from the segment.** Even re-rendered, `segments.json` stays `{characterId, sentenceIds, renderedFallbackEngine}` (storageKey persistence is deferred Wave-1 work). The spike resolves the key by joining `characterId` → the book's `cast.json` voice (`voiceUuid`). The inventory records this join explicitly.
- **Single-series caveat (spec §1, §2 C3):** Keeper is the only ≥2-book Qwen series available, so G1/G2/G6 are **single-series**; the Branch-B sanity-gate band ships **provisional**.
- **Pre-registration is non-negotiable (spec §2 C4):** the **decision RULE + fixed bars** (e.g. G6 AUC ≥ 0.80; G1 cross-book distance must exceed the measured G0 floor by ≥ M standard deviations) are committed to a tracked file **before** any measurement. Data-derived quantities (the G0 floor itself) are measured then plugged into the committed rule — they are *inputs*, not movable goalposts. Phase-1's `FINDINGS.md` records a pre-registered gate discarded mid-spike — do not repeat; a rule change is a logged amendment, never a silent swap.
- **G0 same-text control is the prerequisite (spec §2 C1):** the fixed audition text rendered K times per character (same config) gives the stochastic+identical-content floor (mean + std). The genuine cross-book signal is G1 cross-book centroid distance **expressed in units of that floor's std** — no G1 number is interpretable without G0.
- **Per-character-relative, never a global absolute cutoff** (Phase-1 proved the absolute floor is wide, std 0.09–0.14; only per-character-relative cutoffs separate drift).
- **G5 is BLIND (spec §2 C5):** flagged + matched clips interleaved, randomized, unlabelled; FP/FN scored against the blind key; a second listener on a subset where feasible.
- **Recommendation is exactly one `{go|no-go}` PER AXIS** (cross-book / maturation / per-emotion / wander). Cross-book may go while wander no-goes.
- **Tests:** direct pytest from the sidecar root, NOT `npm run test:sidecar`: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests -v`. **All pure-helper test files (crossbook, blind_listen, the file-walk) import only numpy/stdlib and run UNCONDITIONALLY — there is nothing to skip in the committed tests.** Only the on-box `crossbook_run` *measurement* steps need the venv/weights/sidecar; those are operator-run, not pytest.
- All audio mono int16-LE; ECAPA wants 16 kHz float — resample at embed time (`embed.py` already does this).

---

## File Structure

`srv36` is a valid package; modules import as `spikes.srv36.X`.

| File | Responsibility |
|---|---|
| Create `spikes/srv36/crossbook.py` | New pure helpers: same-text floor mean+std (G0), per-character-relative cross-book drift in floor-std units (G1), seed divergence + spread (G2), genuine-vs-impostor separation AUC (G6), emotion shift (G3), wander slope (G4), and the pre-registered go/no-go evaluator. numpy-only, no I/O. |
| Create `spikes/srv36/voice_index.py` | Pure file-walk + join: `iter_series_books(books_root)` (discover `<author>/<series>/<book>/audio/*.segments.json`) and `resolve_voice_uuid(character_id, cast)` (join `characterId` → `cast.json` voice → `voiceUuid`). Unit-tested against a tmp fixture tree. |
| Create `spikes/srv36/synth_client.py` | Thin HTTP client to the sidecar `/synthesize` (request-builder unit-tested; the HTTP call is operator-run). Renders the fixed per-character audition text K times for G0/G2. |
| Create `spikes/srv36/crossbook_thresholds.json` | The **pre-registered decision rule + fixed bars** (Task 1). |
| Create `spikes/srv36/crossbook_run.py` | On-box driver: walks the re-rendered Keeper books via `voice_index`, resolves `voiceUuid` per character, builds per-(voiceUuid, book) centroids, drives the G0 re-renders via `synth_client`, calls the `crossbook` helpers, writes `results/crossbook_*.json`. Operator-run. |
| Create `spikes/srv36/blind_listen.py` | Builds the blinded G5 clip set (interleaved/randomized/unlabelled, **carrying audio path/timing, not labels**) + scores collected labels into FP/FN. Pure builder + scorer TDD'd; extraction reuses `extract_listen.py`. |
| Create `spikes/srv36/tests/test_crossbook.py`, `tests/test_voice_index.py`, `tests/test_blind_listen.py` | Unit tests for every pure helper + the file-walk/join + the blind builder/scorer. |
| Modify `spikes/srv36/FINDINGS.md` | Append the Phase-2 cross-book section: per-axis measurements + `{go|no-go}`. |
| Modify `spikes/srv36/results/.gitignore` | Negate `crossbook_*.json` (or commit nothing and carry numbers in FINDINGS) — decided in Task 1 (I6). |
| Reuse `metrics.py`, `embed.py`, `gates.py` | cosine/centroid/eer/spread, ECAPA embed, gate labels — unchanged. |

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
  "_comment": "PRE-REGISTERED 2026-06-22 before any measurement. FIXED BARS only. Data-derived inputs (the G0 same-text floor mean+std) are MEASURED in Task 3 and plugged into the rule below — they are inputs, not goalposts. A rule change is a logged FINDINGS.md amendment, never a silent edit.",
  "g6_min_separation_auc": 0.80,
  "g1_max_genuine_drift_stds": 3.0,
  "g5_max_fp_rate": 0.20,
  "g2_material_divergence": 0.08,
  "g3_material_emotion_shift": 0.08,
  "g4_min_wander_slope": 0.02,
  "g4_min_residual_fraction": 0.20
}
```

**Decision rule (the thing being pre-registered).** Cross-book detection is **viable (go)** iff all three hold: (a) **G6** genuine-vs-impostor separation AUC across books ≥ `g6_min_separation_auc` (ECAPA can tell this voice from others, out-of-sample); (b) **G1** the *same* voiceUuid's cross-book centroid distance stays ≤ `g1_max_genuine_drift_stds` × the **measured G0 floor std** (a genuine carried voice does NOT wander across books → low false-positive — a *high* value here is a no-go *regardless of G6*, because the canonical would false-flag correct books); (c) **G5** blind FP rate ≤ `g5_max_fp_rate`. The `g1_…_stds` and `g6` AUC bars are anchored to Phase-1's recorded per-character floor (std 0.09–0.14) and its in-domain separability; they are deliberately conservative and re-derivable from the G0 measurement (log any change). **`per_char_separation` is intentionally NOT a gate** — with only 2 books per character it is structurally degenerate (one pairwise distance); G6's genuine-vs-impostor AUC is the real separation measure.

- [ ] **Step 2: Write the failing test for the evaluator**

```python
# tests/test_crossbook.py
import pytest
from spikes.srv36.crossbook import evaluate_axes

THRESH = {
    "g6_min_separation_auc": 0.80, "g1_max_genuine_drift_stds": 3.0,
    "g5_max_fp_rate": 0.20, "g2_material_divergence": 0.08,
    "g3_material_emotion_shift": 0.08, "g4_min_wander_slope": 0.02,
    "g4_min_residual_fraction": 0.20,
}

def test_cross_book_go_when_separable_consistent_and_low_fp():
    measured = {"g6_separation_auc": 0.88, "g1_genuine_drift_stds": 1.5, "g5_fp_rate": 0.10}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "go"

def test_genuine_voice_wandering_kills_cross_book_regardless_of_g6():
    # same voiceUuid drifts 5 floor-stds across books → canonical would false-flag → no-go
    # even with a perfect impostor-separation AUC
    measured = {"g6_separation_auc": 0.99, "g1_genuine_drift_stds": 5.0, "g5_fp_rate": 0.10}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "no-go"

def test_high_blind_fp_kills_cross_book():
    measured = {"g6_separation_auc": 0.95, "g1_genuine_drift_stds": 1.0, "g5_fp_rate": 0.50}
    assert evaluate_axes(measured, THRESH)["cross_book"] == "no-go"

def test_axes_are_independent():
    measured = {"g6_separation_auc": 0.88, "g1_genuine_drift_stds": 1.5, "g5_fp_rate": 0.10,
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
        measured.get("g6_separation_auc", 0.0) >= t["g6_min_separation_auc"]
        and measured.get("g1_genuine_drift_stds", 1e9) <= t["g1_max_genuine_drift_stds"]
        and measured.get("g5_fp_rate", 1.0) <= t["g5_max_fp_rate"]
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

- [ ] **Step 6: Decide the `results/` commit policy (I6)**

`spikes/srv36/results/.gitignore` exists (Phase-0/1 treated results as machine-local scratch), so a plain `git add results/crossbook_*.json` would silently no-op. **Decision: the machine-specific raw JSON (RTX-4070 / Qwen-0.6B-specific embeddings/AUCs) is NOT committed; the numbers live in `FINDINGS.md` (Task 10).** So the per-task commit steps below add only code + tests, NOT `results/*.json`. (If you instead want the raw JSON committed for reproducibility, negate the pattern in `results/.gitignore` here and `git add -f`.) Update the per-task commit `git add` lines accordingly — they list `results/...` for clarity of what's produced, but those paths are git-ignored unless you opt in.

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_thresholds.json \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py
git commit -m "test(sidecar): pre-register srv-36 Phase-2 cross-book go/no-go thresholds + evaluator"
```

---

## Task 2: Re-render 2 Keeper books + the `voice_index` walk/join (C1, C3)

**Files:**
- Create: `server/tts-sidecar/spikes/srv36/voice_index.py`
- Create: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_voice_index.py`

**Interfaces:**
- Produces: `iter_series_books(books_root) -> Iterator[dict]` — walks `<author>/<series>/<book>/` and yields `{series, bookId, slug, segments_path, cast_path}` for each rendered book (a book is "rendered" if its `audio/*.segments.json` exist). `resolve_voice_uuid(character_id, cast) -> str | None` — joins a `characterId` to its `cast.json` voice's `voiceUuid` (falls back to `voiceId` with a recorded `key_kind` when no uuid). Plus `build_inventory(books_root) -> dict`.

**The re-render is the first step (decision 2026-06-22).** `iter_series_books`/`resolve_voice_uuid` are **pure, unit-tested** (file-walk + dict-join — no GPU). The re-render itself is operator GPU work using the app as a user would.

- [ ] **Step 1: Operator — re-cast + re-render the bounded subset**

Through the current app (so each recurring character is minted a `voiceUuid` carried across both books via series-reuse): re-cast **2 Keeper books**, then render **N chapters each** (N ≥ 3, enough recurring-character lines per book) with `SEG_SPK_ENABLED=1` so `<slug>.embeddings.json` (Phase-1 ECAPA) is written alongside `<slug>.segments.json`. Record the 2 bookIds. (This is normal generation — no spike code yet.)

- [ ] **Step 2: Write the failing tests for the walk + join**

```python
# tests/test_voice_index.py
import json
from pathlib import Path
from spikes.srv36.voice_index import iter_series_books, resolve_voice_uuid

def _mk(tmp, author, series, book, segs, cast):
    d = tmp / author / series / book / "audio"; d.mkdir(parents=True)
    (d / f"{book}.segments.json").write_text(json.dumps(segs), "utf-8")
    (tmp / author / series / book / "cast.json").write_text(json.dumps(cast), "utf-8")

def test_iter_series_books_discovers_rendered_books(tmp_path):
    _mk(tmp_path, "shannon-messenger", "keeper", "book1",
        {"segments": [{"characterId": "sophie", "sentenceIds": [1]}]},
        {"characters": [{"id": "sophie", "voice": {"voiceUuid": "u-soph"}}]})
    books = list(iter_series_books(str(tmp_path)))
    assert len(books) == 1 and books[0]["series"] == "keeper" and books[0]["slug"] == "book1"
    assert Path(books[0]["segments_path"]).exists() and Path(books[0]["cast_path"]).exists()

def test_resolve_voice_uuid_joins_character_to_cast():
    cast = {"characters": [{"id": "sophie", "voice": {"voiceUuid": "u-soph", "voiceId": "sophie"}}]}
    assert resolve_voice_uuid("sophie", cast) == "u-soph"

def test_resolve_voice_uuid_falls_back_to_voiceid():
    cast = {"characters": [{"id": "keefe", "voice": {"voiceId": "keefe"}}]}  # legacy, no uuid
    assert resolve_voice_uuid("keefe", cast) == "keefe"
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_voice_index.py -v`
Expected: FAIL — `No module named 'spikes.srv36.voice_index'`.

- [ ] **Step 4: Implement `voice_index.py`**

```python
# spikes/srv36/voice_index.py
"""Pure file-walk + characterId->voiceUuid join for the Phase-2 cross-book spike."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Iterator


def iter_series_books(books_root: str) -> Iterator[dict]:
    root = Path(books_root)
    for author_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for series_dir in sorted(p for p in author_dir.iterdir() if p.is_dir()):
            for book_dir in sorted(p for p in series_dir.iterdir() if p.is_dir()):
                audio = book_dir / "audio"
                segs = sorted(audio.glob("*.segments.json")) if audio.is_dir() else []
                if not segs:
                    continue  # not rendered
                yield {"series": series_dir.name, "bookId": book_dir.name, "slug": book_dir.name,
                       "segments_path": str(segs[0]), "cast_path": str(book_dir / "cast.json")}


def resolve_voice_uuid(character_id: str, cast: dict):
    for c in cast.get("characters", []):
        if c.get("id") == character_id:
            v = c.get("voice") or {}
            return v.get("voiceUuid") or v.get("voiceId") or character_id
    return None
```

- [ ] **Step 5: Run to verify they pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_voice_index.py -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the inventory driver (joins characterId → voiceUuid; NO storageKey)**

```python
# spikes/srv36/crossbook_run.py  (inventory portion)
"""On-box driver for the Phase-2 cross-book spike. Operator-run."""
from __future__ import annotations
import json, sys
from pathlib import Path
from spikes.srv36.voice_index import iter_series_books, resolve_voice_uuid

def build_inventory(books_root: str) -> dict:
    series = {}
    for s in iter_series_books(books_root):
        cast = json.loads(Path(s["cast_path"]).read_text("utf-8")) if Path(s["cast_path"]).exists() else {}
        sv = series.setdefault(s["series"], {"name": s["series"], "books": [], "keys": {}})
        sv["books"].append({"bookId": s["bookId"], "slug": s["slug"]})
        segs = json.loads(Path(s["segments_path"]).read_text("utf-8")).get("segments", [])
        for seg in segs:
            cid = seg.get("characterId")
            if not cid:
                continue
            # storageKey is NOT persisted (segments-io.ts:54); resolve voiceUuid via cast.json join
            vu = resolve_voice_uuid(cid, cast)
            kind = "voiceUuid" if cast and (next((c for c in cast.get("characters", [])
                    if c.get("id") == cid and (c.get("voice") or {}).get("voiceUuid")), None)) else "voiceId"
            rec = sv["keys"].setdefault(vu, {"key": vu, "character_id": cid, "key_kind": kind, "recurs_in_books": set()})
            rec["recurs_in_books"].add(s["bookId"])
    out = {"series": []}
    for sv in series.values():
        keys = [{**k, "recurs_in_books": sorted(k["recurs_in_books"])} for k in sv["keys"].values()]
        out["series"].append({"name": sv["name"], "books": sv["books"], "keys": keys})
    return out

if __name__ == "__main__":
    inv = build_inventory(sys.argv[1])
    Path("spikes/srv36/results/crossbook_inventory.json").write_text(json.dumps(inv, indent=2), "utf-8")
    for s in inv["series"]:
        multi = [k for k in s["keys"] if len(k["recurs_in_books"]) >= 2]
        print(f"{s['name']}: {len(s['books'])} books, {len(multi)} voiceUuid keys recurring in >=2 books "
              f"(kinds: {sorted({k['key_kind'] for k in multi})})")
```

- [ ] **Step 7: Run on-box + confirm + commit**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.crossbook_run <BOOKS_ROOT>`
Expected: **Keeper shows ≥2 books with ≥1 recurring `voiceUuid` key, kind `voiceUuid`** (proving the re-render worked). Record in FINDINGS which key_kind was exercised (C2). Then:

```bash
git add server/tts-sidecar/spikes/srv36/voice_index.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_voice_index.py
git commit -m "feat(sidecar): srv-36 Phase-2 voice_index walk/join + inventory probe (voiceUuid via cast join)"
```

---

## Task 3: G0 — same-text content control (C1 prerequisite)

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/crossbook.py`
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Produces: `same_text_floor(same_text_embeddings: list[np.ndarray]) -> dict` — given **K embeddings of the SAME fixed audition text rendered K times in one voice's config**, returns `{ "mean": mean pairwise cosine distance, "std": std of those distances }`. This is the stochastic + identical-content floor; its **std** is the unit G1 is expressed in (the evaluator's `g1_genuine_drift_stds`).
- Consumes: `synth_client.render(text, voice_cfg) -> (pcm, sr)` (Task 2.5 / `synth_client.py`) + `embed.embed_pcm`.

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_crossbook.py
import numpy as np
from spikes.srv36.crossbook import same_text_floor

def test_same_text_floor_zero_for_identical():
    e = np.array([0.6, 0.8, 0.0])
    out = same_text_floor([e, e, e])
    assert out["mean"] == pytest.approx(0.0, abs=1e-9) and out["std"] == pytest.approx(0.0, abs=1e-9)

def test_same_text_floor_reports_mean_and_std():
    a = np.array([1.0, 0.0]); b = np.array([0.0, 1.0])
    out = same_text_floor([a, a, b])   # pairwise dists: 0, 1, 1
    assert out["mean"] > 0.5 and out["std"] > 0.0
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py::test_same_text_floor_zero_for_identical -v`
Expected: FAIL — `cannot import name 'same_text_floor'`.

- [ ] **Step 3: Implement**

```python
# append to spikes/srv36/crossbook.py
def same_text_floor(same_text_embeddings) -> dict:
    embs = [np.asarray(e, np.float64) for e in same_text_embeddings]
    if len(embs) < 2:
        return {"mean": 0.0, "std": 0.0}
    dists = [1.0 - cosine(embs[i], embs[j])
             for i in range(len(embs)) for j in range(i + 1, len(embs))]
    return {"mean": float(np.mean(dists)), "std": float(np.std(dists))}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS.

- [ ] **Step 4b: Add the synth client (request-builder TDD'd)**

Create `spikes/srv36/synth_client.py`: a thin POST to the sidecar `/synthesize` with `{ text, engine: "qwen", voice: <storage-key> }`, returning `(pcm_bytes, sample_rate)`. Unit-test the **request body builder** (`build_request(text, voice_cfg) -> dict`) in `tests/test_voice_index.py` or a new `tests/test_synth_client.py` (the HTTP call itself is operator-run, not unit-tested). This is the renderer G0/G2 need; it did not exist (`synthesize.py` is the F1–F5 decider, not a renderer).

- [ ] **Step 5: Wire the on-box G0 measurement into `crossbook_run.py`**

For each recurring `voiceUuid` key, render its character's **fixed audition text K times** (K=12, matching `audition-centroid.ts`) in that voice's current config via `synth_client.render`, embed each with `embed.embed_pcm`, and call `same_text_floor`. Because cast-carry means the config is identical across books, this is the single same-content floor for that voice. Write per-key `{mean, std}` + the cast-wide median std to `results/crossbook_g0.json`.

```python
# crossbook_run.py — G0 measurement (operator-run)
from spikes.srv36.crossbook import same_text_floor
from spikes.srv36.embed import embed_pcm
from spikes.srv36.synth_client import render
# for each recurring key + its audition_text + voice_cfg:
#   embs = [embed_pcm(*render(audition_text, voice_cfg)) for _ in range(K)]  # K renders, same text
#   floors[key] = same_text_floor(embs)   # {mean, std}
```

- [ ] **Step 6: Run on-box + record**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.crossbook_run <BOOKS_ROOT> --g0`
Expected: `results/crossbook_g0.json` written with per-key `{mean, std}`. **Record the cast-wide median floor std** — this is the *unit* G1 (Task 4) divides by; it is a measured input to the committed rule, not a goalpost. (A pathologically large floor mean would itself indicate ECAPA is too content-/session-sensitive here → record as a cross-book concern.)

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g0.json
git commit -m "feat(sidecar): srv-36 Phase-2 G0 same-text content control"
```

---

## Task 4: G1 — genuine-voice cross-book drift, in floor-std units

**Files:**
- Modify: `server/tts-sidecar/spikes/srv36/crossbook.py`
- Modify: `server/tts-sidecar/spikes/srv36/crossbook_run.py`
- Test: `server/tts-sidecar/spikes/srv36/tests/test_crossbook.py`

**Interfaces:**
- Consumes: `same_text_floor` (Task 3 — its `std`), `centroid`/`cosine` (metrics.py).
- Produces: `crossbook_genuine_drift_stds(per_book_clean_embeddings: dict, floor_std: float) -> float` — builds each book's per-key centroid from its CLEAN renders, takes the mean cross-book centroid distance, and returns it **in units of the G0 floor std** (distance / floor_std). For a genuine carried voice this should be **small** (a few stds); a large value means the same voice wanders across books and the canonical would false-flag. **No `per_char_separation`** — with 2 books it is one pairwise distance (max−min ≡ 0); G6 supplies the real separation measure (I2).

- [ ] **Step 1: Write the failing test**

```python
# append to tests/test_crossbook.py
from spikes.srv36.crossbook import crossbook_genuine_drift_stds

def test_drift_stds_small_for_consistent_voice():
    bookA = [np.array([1.0, 0.0]), np.array([0.99, 0.01])]
    bookB = [np.array([0.98, 0.02]), np.array([1.0, 0.0])]
    # centroid distance ~0.0002; floor_std 0.01 → ~0.02 stds → consistent
    assert crossbook_genuine_drift_stds({1: bookA, 2: bookB}, floor_std=0.01) < 1.0

def test_drift_stds_large_for_wandering_voice():
    bookA = [np.array([1.0, 0.0]), np.array([1.0, 0.0])]
    bookB = [np.array([0.0, 1.0]), np.array([0.0, 1.0])]  # whole book shifted → dist 1.0
    assert crossbook_genuine_drift_stds({1: bookA, 2: bookB}, floor_std=0.01) > 50.0

def test_drift_stds_zero_floor_guarded():
    bookA = [np.array([1.0, 0.0])]; bookB = [np.array([1.0, 0.0])]
    # zero floor_std must not divide-by-zero; identical → 0 stds
    assert crossbook_genuine_drift_stds({1: bookA, 2: bookB}, floor_std=0.0) == 0.0
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py::test_drift_stds_small_for_consistent_voice -v`
Expected: FAIL — `cannot import name 'crossbook_genuine_drift_stds'`.

- [ ] **Step 3: Implement**

```python
# append to spikes/srv36/crossbook.py
def crossbook_genuine_drift_stds(per_book_clean_embeddings: dict, floor_std: float) -> float:
    book_centroids = [centroid(embs) for embs in per_book_clean_embeddings.values() if len(embs)]
    if len(book_centroids) < 2:
        return 0.0
    dists = [1.0 - cosine(book_centroids[i], book_centroids[j])
             for i in range(len(book_centroids)) for j in range(i + 1, len(book_centroids))]
    mean_dist = float(np.mean(dists))
    if floor_std <= 0.0:
        return 0.0 if mean_dist == 0.0 else float("inf")
    return mean_dist / floor_std
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m pytest spikes/srv36/tests/test_crossbook.py -v`
Expected: PASS.

- [ ] **Step 5: Wire the on-box measurement**

In `crossbook_run.py --g1`: for each recurring key, slice the **clean (gate-passing, per `gates.is_gate_flagged`)** per-segment PCM from each re-rendered Keeper book (join `characterId` → `voiceUuid` via `voice_index`), embed, group by book, call `crossbook_genuine_drift_stds` with that key's Task-3 `floor_std`. Take the **cast-wide median** of the per-key drift-stds as `g1_genuine_drift_stds`. Write `results/crossbook_g1.json`.

- [ ] **Step 6: Run on-box + record vs the pre-registered threshold**

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.crossbook_run <BOOKS_ROOT> --g1`
Expected: record the cast-wide median `g1_genuine_drift_stds`; compare to the committed `g1_max_genuine_drift_stds` (3.0) — do NOT adjust the threshold to fit. A value above it = the carried voice wanders across books → cross-book no-go (the canonical would false-flag).

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/spikes/srv36/crossbook.py \
        server/tts-sidecar/spikes/srv36/crossbook_run.py \
        server/tts-sidecar/spikes/srv36/tests/test_crossbook.py \
        server/tts-sidecar/spikes/srv36/results/crossbook_g1.json
git commit -m "feat(sidecar): srv-36 Phase-2 G1 genuine-voice cross-book drift in floor-std units"
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

In `crossbook_run.py --g2`: reuse the **K audition embeddings already rendered in Task 3** (K=12) to build the audition centroid; build the per-book clean centroids (Task 4); call `seed_divergence`; write `results/crossbook_g2.json`. Run on-box; record `central` (→ Branch A vs B) and `spread` (→ provisional sanity-gate band). **Mark the band single-series/provisional** in the output (only Keeper). Because cast-carry uses one config across books, expect `central` small (audition ≈ both books) under the happy path — a large `central` is itself a finding.

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

def test_separation_auc_all_ties_is_exactly_half():
    assert separation_auc([0.5, 0.5], [0.5, 0.5]) == pytest.approx(0.5)

def test_separation_auc_interleaved_is_near_half():
    # genuinely overlapping distributions → ~0.5, not a degenerate all-ties path
    assert 0.3 <= separation_auc([0.4, 0.6], [0.5, 0.5]) <= 0.7
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

def test_build_blind_set_strips_labels_keeps_audio_and_is_deterministic():
    flagged = [{"id": "f1", "audio": "a/f1.wav", "start": 0.0, "end": 3.0, "is_flagged": True}]
    matched = [{"id": "m1", "audio": "a/m1.wav", "start": 1.0, "end": 4.0, "is_flagged": False}]
    pres1, key1 = build_blind_set(flagged, matched, seed=42)
    pres2, _ = build_blind_set(flagged, matched, seed=42)
    assert [c["id"] for c in pres1] == [c["id"] for c in pres2]   # deterministic
    # blind: no label leaks, but the audio path/timing the operator needs IS carried
    assert all("label" not in c and "is_flagged" not in c for c in pres1)
    assert all("audio" in c and "start" in c and "end" in c for c in pres1)
    assert key1["f1"] == "flagged" and key1["m1"] == "matched"

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


_AUDIO_FIELDS = ("id", "audio", "start", "end")  # carried; everything else (labels) dropped


def build_blind_set(flagged, matched, seed: int):
    answer_key, pool = {}, []
    for truth, clips in (("flagged", flagged), ("matched", matched)):
        for c in clips:
            answer_key[c["id"]] = truth
            pool.append({k: c[k] for k in _AUDIO_FIELDS if k in c})  # strip labels, keep audio
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

Add a `--report` mode to `crossbook_run.py` that loads `results/crossbook_g{0,1,2,3,4,5,6}.json`, assembles the `measured` dict — in particular computing `g1_genuine_drift_stds` from the G1 cross-book distance ÷ the G0 floor `std`, and pulling `g6_separation_auc`, `g5_fp_rate`, `g2_divergence`, `g3_emotion_shift`, `g4_*` — loads `crossbook_thresholds.json`, calls `evaluate_axes`, and prints the per-axis verdict.

Run: `cd server/tts-sidecar && .venv/Scripts/python.exe -m spikes.srv36.crossbook_run --report`
Expected: prints `{cross_book, maturation, per_emotion, wander}` each `go|no-go`.

- [ ] **Step 2: Append the Phase-2 section to FINDINGS.md**

Append a `## Phase 2 — cross-book consistency` section recording, verbatim: the **pre-registered thresholds**; the measured G0–G6 numbers; the **keying exercised** (voiceId vs voiceUuid, C2); the **single-series Keeper** caveat (C3); the **blind** G5 FP/FN (C5); and the **per-axis `{go|no-go}`** from `evaluate_axes`. If any threshold was amended mid-spike, log the amendment + rationale here (C4).

- [ ] **Step 3: Commit**

```bash
# results/*.json are git-ignored (I6); the numbers live in FINDINGS.md, not raw JSON
git add server/tts-sidecar/spikes/srv36/FINDINGS.md \
        server/tts-sidecar/spikes/srv36/crossbook_run.py
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
- **Placeholders:** the **pure-helper tasks** (1, 3, 4, 5, 6, 7, 8, 9) have real test + implementation code, no placeholders. The **on-box measurement steps** (Task 2 Step 1 re-render; the `--g0/g1/...` wiring) are deliberately procedural prose + a representative code sketch — they orchestrate live GPU renders against the operator's library and are not unit-testable; this is acceptable for a throwaway research spike but is NOT the same as "exact code for every step." Stated honestly rather than over-claimed. ✓ (with that caveat)
- **Type consistency:** `evaluate_axes` reads `g6_separation_auc`, `g1_genuine_drift_stds`, `g5_fp_rate`, `g2_divergence`, `g3_emotion_shift`, `g4_wander_slope`, `g4_residual_fraction` — these match the metric functions' outputs (G0's `same_text_floor` returns `{mean,std}`; the `--report` mode divides the G1 cross-book distance by the G0 `std` to form `g1_genuine_drift_stds`) and the `crossbook_thresholds.json` keys. **No `per_char_separation` anywhere** (removed, I2). The `--report` mode (Task 10) assembles exactly the keys `evaluate_axes` reads. ✓
