# fs-55 — Anchored Emotion-Variant Drift Fix — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Qwen emotion-variant voices (`<base>__angry`, `__sad`, `__excited`, `__whisper`) from drifting to a different-sounding person by minting each variant **from the base voice's own identity** instead of independently re-sampling VoiceDesign. Resolves **fs-55 (#993)**.

**Architecture:** Base voices keep today's `design_voice` path (a single base never drifts). **Variants** switch to a new anchored path: load the base's on-disk `.pt`, decode its `ref_code` → reference clip, re-derive a **1.7B-Base ICL** prompt, synth *the base voice performing the emotion* via the raw-`generate` clone+instruct bypass, then distil that emotion clip to a **0.6B ICL `.pt`**. Every variant shares the base identity → drift gone by construction.

**Tech Stack:** Python TTS sidecar (`server/tts-sidecar/main.py`, `qwen_tts` 0.1.1, torch 2.11/cu128), Node/Express (`server/src/routes/qwen-voice.ts`, `cast-design.ts`), pytest (`fake_qwen_runtime` + `_FakeQwenModel`) + vitest (supertest + `fetchMock`).

## Global Constraints

- **Installed `qwen-tts` is 0.1.1.** The raw `Qwen3TTSForConditionalGeneration.generate()` combines `voice_clone_prompt` (ICL) + `instruct_ids` in independent additive branches (`modeling_qwen3_tts.py:2076-2080` + concat `:2237`); the public wrapper never wires them, so we call `self._base17.model.generate(...)` directly. **Pin `qwen-tts` + guard test** (verified methods exist: `_build_assistant_text:269`, `_build_ref_text:272`, `_build_instruct_text:275`, `_tokenize_texts:278`, `_merge_generate_kwargs:287`, `_prompt_items_to_voice_clone_prompt:460`, `create_voice_clone_prompt:356` tuple form OK, `speech_tokenizer.decode:307`).
- **VRAM invariant:** at most one *VoiceDesign-class* heavy model at a time. Minting evicts Kokoro (mirror `design_voice` main.py:1533-1536), does the 1.7B-Base work, **unloads the 1.7B**, then loads the 0.6B for the distil. The 0.6B Base (~1 GB) may co-reside with the 1.7B-Base (~3.4 GB) during the 1.7B phase (~4.4 GB total — within the 8 GB budget, same envelope as today's `design_voice` 0.6B+1.7B-VoiceDesign peak). Variant `.pt` **must** be ICL.
- **0.6B `.pt` is dim-incompatible with the 1.7B** (1024 vs 2048 speaker-embedding) — re-derive the base ICL prompt on the 1.7B from the decoded `ref_code`, never load it directly.
- **Name/contract stability:** variant id stays `${base}__${emotion}`; preview ids via `previewVoiceIdFor` (`qwen-voice.ts:222`); `.pt`/`.json` paths via `_voice_paths`.
- **Sidecar GPU tests SKIP+exit-0 when weights/venv absent** (existing `test:sidecar` convention; gate via the new `_qwen_weights_present()` from Task 0).
- **Spec** (on `main`, merged PR #1002): `docs/superpowers/specs/2026-06-22-expressive-tts-instruct-tiers-design.md` §4.2/§4.3/§11. **Setup:** this worktree was branched before #1002 (network-down fetch failed); **rebase on `origin/main` once network returns** so the spec + #1002 are present (Task 8 Step 0).

### v2 changelog — adversarial-review findings folded in

| Finding | Where addressed |
|---|---|
| Crit — invented test fixtures | All tests rewritten against real `fake_qwen_runtime`/`_FakeQwenModel` (+ explicit fake-surface extensions in Tasks 2-3) and `TestClient(main.app)` |
| Crit — preview/A-B clobber | Task 4/5/6 thread `preview` (anchor to the REAL base; write the `-preview` id) |
| Maj — `_load_model` typo | Task 1 uses `_load_qwen_model` |
| Maj — version guard crashes | Task 2 uses `importlib.metadata.version("qwen-tts")` |
| Maj — 1.7B-Base instruct unproven from repo | **Task 0** commits a reproducible smoke (also closes the R2-C1 provenance gap) |
| Maj — no non-GPU coverage of the path | Task 4 adds a fake-runtime **call-sequence** test |
| Maj — Node test phantom API | Task 6 uses supertest + `fetchMock` |
| Maj — base `.pt` absent → bare 500 | Task 4 raises a typed error; Task 5 maps to 409 |
| Mod — Kokoro evict / single-flight lock / codec compat / audition-cache | Task 1 lock; Task 4 evict + codec covered by Task 0; Task 6 verifies audition key |
| Min — `_resample24k`, cancellation | Task 3 defines it; Task 5 documents liveness reuse |
| "spec missing" / "Closes #993 mismatch" | Non-issues: spec is on `main` (worktree stale); `Closes #993` is the operator's explicit decision (close the detection-gate feature as obviated by prevention) |

---

### Task 0: Reproducible feasibility smoke (commit the evidence)

**Files:**
- Create: `server/tts-sidecar/tests/golden/instruct_smoke.py` (committed, weights-gated runner)
- Modify: `server/tts-sidecar/conftest.py` (the EXISTING root conftest — add `_qwen_weights_present()` here; the test files put SIDECAR_ROOT on `sys.path`, so `from conftest import …` resolves to this file, NOT a `tests/conftest.py`)
- Test: this task's deliverable IS the committed runner + a recorded result line in Ship Notes

**Interfaces:**
- Produces: `_qwen_weights_present() -> bool` (used by every GPU-gated test); a runnable `instruct_smoke.py` that prints, for one designed voice: ECAPA distance(base, instruct-variant) per emotion + reconstructs the base `ref_code` on the 1.7B (codec-compat check).

- [ ] **Step 1: Add `_qwen_weights_present()`**

```python
# server/tts-sidecar/conftest.py  (the EXISTING root conftest)
def _qwen_weights_present() -> bool:
    """True only when the real qwen-tts + Qwen3-TTS weights are importable/loadable.
    Gates GPU tests so CI / dev venvs SKIP instead of failing."""
    try:
        import qwen_tts  # noqa: F401
        import torch  # noqa: F401
        return torch.cuda.is_available()
    except Exception:
        return False
```

- [ ] **Step 2: Write the committed smoke runner** (`instruct_smoke.py`)

It must, gated on `_qwen_weights_present()`: load 1.7B-Base, take a designed voice's `.pt`, **decode its `ref_code` → clip** (codec-compat proof), re-derive a 1.7B ICL prompt, synth the SAME line under neutral vs angry vs whisper instructs via `model.generate(voice_clone_prompt + instruct_ids)`, write WAVs + print ECAPA `speaker_distance(base, variant)` per emotion. Exit 0 + SKIP banner when weights absent.

- [ ] **Step 3: Run it on the GPU box; record results**

Run: `server/tts-sidecar/.venv/Scripts/python.exe server/tts-sidecar/tests/golden/instruct_smoke.py`
Expected (on weights box): prints distances; operator **listens** — confirms identity holds + emotion audible. **Paste the distance lines into Ship Notes.** This is the reproducible replacement for the deleted spike (R2-C1) and the empirical proof the 1.7B-Base obeys instruct (Major-6).

- [ ] **Step 4: Commit**

```bash
git add server/tts-sidecar/tests/golden/instruct_smoke.py server/tts-sidecar/conftest.py
git commit -m "test(side): committed reproducible 1.7B-Base instruct + codec-compat smoke (fs-55, R2-C1)"
```

> **Gate:** If Step 3 shows identity drift OR no emotion change, STOP — the anchored approach needs rethinking before Tasks 1-7. (Spike already indicated PASS; this re-establishes it reproducibly.)

---

### Task 1: Wire Qwen 1.7B-Base into setup (side-20 #999)

**Files:**
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs` (model consts ~66-68; prefetch ~257)
- Modify: `server/tts-sidecar/main.py` (`QwenEngine`: `BASE17_MODEL`, `_base17`, `_base17_load_lock`, `_ensure_base17_loaded`, `unload_base17`; startup preload block ~2566-2633; `/load`~3088 + `/unload`~3162 qwen branch; `/health`~2894-2935)
- Modify: `server/.env.example` (`PRELOAD_QWEN_BASE17`); `src/components/layout.tsx` (Qwen-1.7B pill)
- Test: `scripts/tests/install-qwen3-base17.test.mjs` (new) + `server/tts-sidecar/tests/test_qwen3.py` + `src/components/ModelControlPill.test.tsx`

**Interfaces:**
- Produces: `qwenPrefetchModels({skipDesign}) -> string[]` (exported); `QwenEngine.BASE17_MODEL`, `_ensure_base17_loaded()`, `unload_base17()`; `/load`+`/unload` accept `{engine:"qwen", model:"1.7b"}`; `/health.qwen_base17_loaded`; `PRELOAD_QWEN_BASE17` boot flag.
- **First-class like other models** (operator decision): preload flag + load/unload + health + pill, mirroring the existing Qwen/Kokoro/Coqui patterns (per the seam map).

- [ ] **Step 1: Failing test for the install model-list helper**

```js
// scripts/tests/install-qwen3-base17.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qwenPrefetchModels } from '../../server/tts-sidecar/scripts/install-qwen3.mjs';
test('1.7B-Base prefetched even with --skip-design (needed for variant minting)', () => {
  const a = qwenPrefetchModels({ skipDesign: false });
  assert.ok(a.includes('Qwen/Qwen3-TTS-12Hz-1.7B-Base'));
  assert.ok(a.includes('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'));
  const b = qwenPrefetchModels({ skipDesign: true });
  assert.ok(b.includes('Qwen/Qwen3-TTS-12Hz-1.7B-Base'));
  assert.ok(!b.includes('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'));
});
```

- [ ] **Step 2: Run → fail.** `node --test scripts/tests/install-qwen3-base17.test.mjs` → FAIL (not exported).

- [ ] **Step 3: Implement the helper + const in `install-qwen3.mjs`**

```js
const BASE_17B_MODEL = process.env.QWEN_BASE_17B_MODEL || 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
export function qwenPrefetchModels({ skipDesign }) {
  const ids = [BASE_MODEL, BASE_17B_MODEL];
  if (!skipDesign) ids.push(VOICEDESIGN_MODEL);
  return ids;
}
```

Replace the inline `models` array in `main()` (~257) with `qwenPrefetchModels({ skipDesign: SKIP_DESIGN })`; update the size hint to add `+ ~3.4 GB 1.7B-Base`.

- [ ] **Step 4: Run → pass.** Same command → PASS.

- [ ] **Step 5: Add `_base17` loader with single-flight lock (main.py)** — mirror `_ensure_base_loaded` (`:1284`) + `_base_load_lock` (`:1139`):

```python
BASE17_MODEL = os.environ.get("QWEN_BASE_17B_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
# in __init__: self._base17 = None; self._base17_load_lock = threading.Lock()
# ALSO update the `fake_qwen_runtime` fixture to reset engine._base17 = None on
# setup + teardown (mirror its _base/_design reset) so a mint test can't leak _base17.

def _ensure_base17_loaded(self) -> None:
    if self._base17 is not None:
        return
    with self._base17_load_lock:        # single-flight (mirror _base_load_lock)
        if self._base17 is not None:
            return
        self._base17 = self._load_qwen_model(self.BASE17_MODEL)  # NOTE: _load_qwen_model

def unload_base17(self) -> None:
    with self._synth_lock:
        self._base17 = None
    _reclaim_host_and_vram()
```

- [ ] **Step 6: Weights-gated loader test (test_qwen3.py)**

```python
from conftest import _qwen_weights_present
@pytest.mark.skipif(not _qwen_weights_present(), reason="weights absent")
def test_ensure_base17_loads_a_base_checkpoint():
    eng = main.ENGINES["qwen"]; eng._ensure_base17_loaded()
    assert getattr(eng._base17.model, "tts_model_type", None) == "base"
    eng.unload_base17(); assert eng._base17 is None
```

- [ ] **Step 7: Run + commit.** `npm run test:hooks` (runs the new `.mjs` node test — NOT `test:sidecar`, which is pytest, nor `test:scripts`, which is Pester) **and** `npm run test:sidecar` (the gated pytest loader test SKIPs off-box).
```bash
git add server/tts-sidecar/scripts/install-qwen3.mjs scripts/tests/install-qwen3-base17.test.mjs server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(side): wire Qwen 1.7B-Base into setup + single-flight loader (side-20)"
```

> **Lifecycle wiring (operator chose: make the 1.7B-Base first-class like the other models).** Steps 8–12 mirror the EXISTING patterns the seam map identified — copy them, don't invent. Target the 1.7B-Base with a `model: "1.7b"` selector on the existing qwen `/load`/`/unload` (the 0.6B stays the default when `model` is absent).

- [ ] **Step 8: `PRELOAD_QWEN_BASE17` boot flag.** In the startup preload block (`main.py` `_preload_default_engines`, ~2566-2633, mirror the `PRELOAD_QWEN` branch ~2613-2633):

```python
if _parse_bool(os.environ.get("PRELOAD_QWEN_BASE17"), False):
    qwen = ENGINES.get("qwen")
    if isinstance(qwen, QwenEngine):
        try:
            log.info("Preloading Qwen 1.7B-Base at startup (PRELOAD_QWEN_BASE17=1)…")
            await asyncio.to_thread(qwen._ensure_base17_loaded)
            log.info("Qwen 1.7B-Base preload complete.")
        except Exception as e:
            log.warning("Qwen 1.7B-Base preload failed (%s); warms on demand via /load model=1.7b.", e)
```
Document `PRELOAD_QWEN_BASE17` in `server/.env.example`.

- [ ] **Step 9: `/load` + `/unload` target.** In the qwen branch of `POST /load` (~3088-3108) and `POST /unload` (~3162-3166), read `body.get("model")`: when it's `"1.7b"`, route to `_ensure_base17_loaded` / `unload_base17` (under `qwen._load_lock`); otherwise keep the existing 0.6B `_ensure_base_loaded` / `unload`. **Test (TestClient):** `POST /load {engine:"qwen", model:"1.7b"}` returns `{status:"ready"}` (gated/mocked) and a no-model call still loads the 0.6B.

- [ ] **Step 10: `/health` flag.** In `GET /health` (~2894-2935) add `qwen_base17_loaded = qwen._base17 is not None` (mirror `qwen_loaded` ~2902) and surface it in the response dict + `devices["qwen"]` already covers device. **Test:** `/health` JSON contains `qwen_base17_loaded` (False on a cold engine).

- [ ] **Step 11: `ModelControlPill` (frontend).** Add a "Qwen 1.7B" pill in `src/components/layout.tsx` alongside the existing Qwen pill, `engineLabel="Qwen 1.7B"`, reading `qwen_base17_loaded`/loading from the health poll and calling `/load`/`/unload` with `{engine:"qwen", model:"1.7b"}`. Mirror the existing Qwen pill wiring (no new component). **Test:** a focused RTL test that the pill renders the loaded/idle label off the `qwen_base17_loaded` flag (mirror the existing pill test).

- [ ] **Step 12: Run + commit.** `npm run test:sidecar` + `cd server && npm run test` (route/health) + `npm run test` (frontend pill).
```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py server/.env.example src/components/layout.tsx src/components/ModelControlPill.test.tsx
git commit -m "feat(side,fe): 1.7B-Base lifecycle — PRELOAD flag, load/unload, health, pill (side-20)"
```

---

### Task 2: Raw-`generate` ICL + instruct synth helper

**Files:**
- Modify: `server/tts-sidecar/main.py` (`QwenEngine._icl_instruct_synth`)
- Modify: `server/tts-sidecar/tests/test_qwen3.py` (extend `_FakeQwenModel` with the wrapper internals the helper calls)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Consumes: `_ensure_base17_loaded` (Task 1).
- Produces: `QwenEngine._icl_instruct_synth(prompt_items, text, instruct, lang) -> tuple[np.ndarray, int]`.

- [ ] **Step 1: Extend the fake to expose the wrapper surface the helper uses**

Add to `_FakeQwenModel` (so the non-GPU test can drive `_icl_instruct_synth`):

```python
# inside _FakeQwenModel
def _build_assistant_text(self, t): return f"A:{t}"
def _build_ref_text(self, t): return f"R:{t}"
def _build_instruct_text(self, t): return f"I:{t}"
def _tokenize_texts(self, texts): return [("ids", s) for s in texts]
def _merge_generate_kwargs(self, **kw): return {}
def _prompt_items_to_voice_clone_prompt(self, items):
    return {"ref_code": [getattr(it, "ref_code", None) for it in items]}
# _FakeInnerModule gains:
def generate(self, **kw):
    self.last_generate = kw
    return ([__import__("numpy").array([1, 2, 3])], None)
class _FakeTokenizerStub:
    def decode(self, codes): return [__import__("numpy").zeros(6000, dtype="float32")], 24000
# set self.model.speech_tokenizer = _FakeTokenizerStub() in _FakeInnerModule.__init__
```

- [ ] **Step 2: Failing test (instruct_ids/ref_ids are built + passed)**

```python
def test_icl_instruct_synth_passes_instruct_and_clone(fake_qwen_runtime):
    eng = fake_qwen_runtime["engine"]
    eng._base17 = main.__dict__["Qwen3TTSModel"]("1.7b") if False else eng._base  # ensure a fake wrapper
    eng._base17 = type(eng._base)("1.7b")  # fresh fake wrapper
    item = type("It", (), {"ref_code": 7, "ref_text": "calib"})()
    wav, sr = eng._icl_instruct_synth([item], "Hello.", "Delivered angrily.", "English")
    kw = eng._base17.model.last_generate
    assert kw["instruct_ids"] is not None and "voice_clone_prompt" in kw and "ref_ids" in kw
    assert sr == 24000
```

- [ ] **Step 3: Run → fail.** `python -m pytest ...::test_icl_instruct_synth_passes_instruct_and_clone -v` → FAIL (not defined).

- [ ] **Step 4: Implement `_icl_instruct_synth`** (replicate the wrapper ICL trim; add instruct_ids):

```python
def _icl_instruct_synth(self, prompt_items, text, instruct, lang):
    import torch
    w = self._base17; m = w.model
    vcp = w._prompt_items_to_voice_clone_prompt(prompt_items)
    input_ids = w._tokenize_texts([w._build_assistant_text(text)])
    rt = getattr(prompt_items[0], "ref_text", None)
    ref_ids = [w._tokenize_texts([w._build_ref_text(rt)])[0]] if rt else [None]
    instruct_ids = w._tokenize_texts([w._build_instruct_text(instruct)])
    gk = w._merge_generate_kwargs()
    with torch.no_grad():
        codes, _ = m.generate(input_ids=input_ids, ref_ids=ref_ids, instruct_ids=instruct_ids,
                              voice_clone_prompt=vcp, languages=[lang], non_streaming_mode=True, **gk)
    rcl = vcp.get("ref_code")
    cfd = [torch.cat([rcl[i].to(c.device), c], dim=0) if rcl and rcl[i] is not None else c
           for i, c in enumerate(codes)]
    wavs, sr = m.speech_tokenizer.decode([{"audio_codes": c} for c in cfd])
    wav = wavs[0]
    if rcl and rcl[0] is not None:
        cut = int(int(rcl[0].shape[0]) / max(int(cfd[0].shape[0]), 1) * wav.shape[0]); wav = wav[cut:]
    return wav, int(sr)
```

(The fake's `torch.cat`/`.to`/`.shape` are exercised only on the real-weights path; for the non-GPU test, `ref_code` is an int → the `rcl[i] is not None` branch runs `torch.cat` on the fake torch — make the fake `torch.cat`/tensor ops no-op-tolerant, OR have the test set `ref_code=None` to skip the trim. Use `ref_code=None` in the unit test; the trim path is covered by Task 0's real smoke.)

- [ ] **Step 5: Run → pass.** Same command → PASS (with `ref_code=None` in the test item).

- [ ] **Step 6: Version-pin guard (correct API)**

```python
def test_qwen_tts_pinned_for_raw_bypass():
    from importlib.metadata import version
    assert version("qwen-tts").startswith("0.1."), "re-verify raw generate() branches before bumping (fs-55)"
```

Pin `qwen-tts==0.1.1` in `server/tts-sidecar/requirements/base.txt`.

- [ ] **Step 7: Run + commit.** `npm run test:sidecar`
```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py server/tts-sidecar/requirements/base.txt
git commit -m "feat(side): raw-generate ICL+instruct synth helper + qwen-tts pin guard (fs-55)"
```

---

### Task 3: ECAPA identity-distance helper (M7)

**Files:** Modify `server/tts-sidecar/main.py`; Test `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:** Produces module-level `cosine_distance(a, b) -> float`, `_resample24k(wav, sr) -> np.ndarray`, and `QwenEngine.speaker_distance(wav_a, sr_a, wav_b, sr_b) -> float`.

> **REUSE FIRST (CLAUDE.md "don't gold-plate"):** the repo already ships a dedicated ECAPA `SpeakerEngine` as `main.SPK` (192-dim, unit-norm) plus a `cosine` helper in `spikes/srv36/metrics.py` (covered by `test_speaker_embed.py`). At execution, **verify their signatures and prefer `SPK.embed(wav, sr)` + that `cosine`** for both clips instead of pulling embeddings from the 0.6B synth model. The `cosine_distance`/`speaker_distance` below is the **fallback** only if `SPK`'s lifecycle/signature doesn't fit (it's self-consistent — same encoder both clips — so either is sound for the relative metric).

- [ ] **Step 1: Failing pure-cosine test**

```python
def test_cosine_distance_pure():
    import numpy as np
    from main import cosine_distance
    v = np.array([1.0, 0.0], np.float32)
    assert cosine_distance(v, v) == pytest.approx(0.0, abs=1e-6)
    assert cosine_distance(v, np.array([0.0, 1.0], np.float32)) == pytest.approx(1.0, abs=1e-6)
```

- [ ] **Step 2: Run → fail.** → FAIL (not defined).

- [ ] **Step 3: Implement** (module level):

```python
def cosine_distance(a, b) -> float:
    import numpy as np
    a = np.asarray(a, np.float64).ravel(); b = np.asarray(b, np.float64).ravel()
    denom = (np.linalg.norm(a) * np.linalg.norm(b)) or 1.0
    return float(1.0 - (a @ b) / denom)

def _resample24k(wav, sr):
    import numpy as np
    a = np.asarray(wav, dtype=np.float32).ravel()
    if int(sr) == 24000:
        return a
    import math
    idx = (np.arange(0, len(a), sr / 24000.0)).astype(np.int64)
    idx = idx[idx < len(a)]
    return a[idx]  # nearest-sample resample (embedding is robust; avoids a librosa dep)
```

```python
def speaker_distance(self, wav_a, sr_a, wav_b, sr_b) -> float:
    self._ensure_base_loaded()
    m = self._base.model
    ea = m.extract_speaker_embedding(audio=_resample24k(wav_a, sr_a), sr=24000)
    eb = m.extract_speaker_embedding(audio=_resample24k(wav_b, sr_b), sr=24000)
    import numpy as np
    return cosine_distance(np.asarray(ea.detach().cpu()), np.asarray(eb.detach().cpu()))
```

- [ ] **Step 4: Run → pass.** Pure-cosine test PASS. (A weights-gated `speaker_distance` sanity test — identical clip → ~0 — lives in Task 4's regression.)

- [ ] **Step 5: Commit**
```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(side): ECAPA speaker-distance + 24k resample helpers (fs-55 M7)"
```

---

### Task 4: Anchored variant minting (`mint_variant`)

**Files:** Modify `server/tts-sidecar/main.py` (near `design_voice` ~1493); Test `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:** Produces `QwenEngine.mint_variant(base_voice_id, variant_voice_id, emotion_instruct, language, calibration_text, voice_uuid) -> SynthResult`. Raises `VoiceNotDesignedError` (new typed error) if the base `.pt` is absent.

- [ ] **Step 1: Non-GPU call-sequence test (the core coverage the v1 plan lacked)**

```python
def test_mint_variant_anchors_to_base_and_marks_json(fake_qwen_runtime, monkeypatch):
    eng = fake_qwen_runtime["engine"]; vdir = fake_qwen_runtime["dir"]
    # base voice exists on disk (design it via the fake path)
    eng.design_voice("v1", "A warm narrator.", "English", None, None)
    calls = []
    monkeypatch.setattr(eng, "_ensure_base17_loaded", lambda: calls.append("load17"))
    monkeypatch.setattr(eng, "unload_base17", lambda: calls.append("unload17"))
    monkeypatch.setattr(eng, "_icl_instruct_synth",
                        lambda items, text, instr, lang: (calls.append("instruct_synth"), (__import__("numpy").zeros(6000, "float32"), 24000))[1])
    # CRITICAL: the shared fake's create_voice_clone_prompt returns a DICT (no .ref_code),
    # so stub _load_voice_prompt to hand back a ref_code-bearing item (ref_code=None skips the
    # fake decode-trim cleanly). Without this, mint_variant's `base_item.ref_code` AttributeErrors.
    import types as _types
    monkeypatch.setattr(eng, "_load_voice_prompt",
                        lambda v: ([_types.SimpleNamespace(ref_code=None, ref_text="calib")], "English", False))
    # base17 wrapper needed for decode + ICL re-derive (has speech_tokenizer via Task 2's fake)
    eng._base17 = type(eng._base)("1.7b")
    eng.mint_variant("v1", "v1__angry", "Delivered angrily.", "English", None, "uuid-1")
    assert calls.index("instruct_synth") < calls.index("unload17")     # 1.7B work before unload
    import json, os
    meta = json.load(open(os.path.join(vdir, "v1__angry.json"), encoding="utf-8"))
    assert meta["anchoredTo"] == "v1" and meta["mintMethod"] == "anchored-icl-instruct"
    assert meta["voiceUuid"] == "uuid-1"

def test_mint_variant_raises_when_base_absent(fake_qwen_runtime):
    eng = fake_qwen_runtime["engine"]
    with pytest.raises(main.VoiceNotDesignedError):
        eng.mint_variant("nope", "nope__sad", "Delivered sadly.", "English", None, None)
```

- [ ] **Step 2: Run → fail.** → FAIL (`mint_variant`/`VoiceNotDesignedError` undefined).

- [ ] **Step 3: Implement `VoiceNotDesignedError` + `mint_variant`**

```python
class VoiceNotDesignedError(RuntimeError):
    """Base voice has no cached .pt — design it before minting a variant."""

def mint_variant(self, base_voice_id, variant_voice_id, emotion_instruct,
                 language, calibration_text, voice_uuid=None) -> "SynthResult":
    import torch
    lang = (language or self.DEFAULT_LANGUAGE).strip() or self.DEFAULT_LANGUAGE
    ref_text = self.CALIBRATION_TEXT
    audition_text = (calibration_text or self.CALIBRATION_TEXT).strip() or self.CALIBRATION_TEXT
    base_pt, _json = self._voice_paths(base_voice_id)
    if not os.path.isfile(base_pt):
        raise VoiceNotDesignedError(f"base voice '{base_voice_id}' not designed (no {base_pt}).")
    base_prompt, _b, _ = self._load_voice_prompt(base_voice_id)
    base_item = (base_prompt if isinstance(base_prompt, list) else [base_prompt])[0]

    # --- 1.7B phase (Kokoro evicted by _VD_KOKORO.design(), mirrors design_voice) ---
    with _VD_KOKORO.design():
        # evict Kokoro the same way design_voice does (main.py:1533-1536)
        kok = ENGINES.get("kokoro")
        if kok is not None and hasattr(kok, "unload"):
            kok.unload()
        self._ensure_base17_loaded()
        with self._synth_lock:
            self._ensure_base17_loaded()
            rc = base_item.ref_code
            rc = rc.to(self._device) if hasattr(rc, "to") else rc
            ref_wavs, ref_sr = self._base17.model.speech_tokenizer.decode([{"audio_codes": rc}])
            icl = self._base17.create_voice_clone_prompt(ref_audio=(ref_wavs[0], ref_sr), ref_text=ref_text)
            icl = icl if isinstance(icl, list) else [icl]
            emo_wav, emo_sr = self._icl_instruct_synth(icl, ref_text, emotion_instruct, lang)
    self.unload_base17()  # one-heavy-model invariant

    # --- 0.6B phase: distil the emotion clip into a variant .pt ---
    with self._synth_lock:
        self._ensure_base_loaded()
        prompt = self._base.create_voice_clone_prompt(ref_audio=(emo_wav, emo_sr), ref_text=ref_text)
    os.makedirs(self._voices_dir, exist_ok=True)
    pt_path, json_path = self._voice_paths(variant_voice_id)
    torch.save(prompt, pt_path)
    import json as _json
    with open(json_path, "w", encoding="utf-8") as fh:
        _json.dump({"voiceId": variant_voice_id, "voiceUuid": voice_uuid, "instruct": emotion_instruct,
                    "language": lang, "refText": ref_text, "baseModel": self.BASE_MODEL,
                    "designModel": self.BASE17_MODEL, "anchoredTo": base_voice_id,
                    "mintMethod": "anchored-icl-instruct"}, fh, ensure_ascii=False, indent=2)
    with self._cache_lock:
        self._prompt_cache.pop(variant_voice_id, None)
    with self._synth_lock:
        self._ensure_base_loaded()
        wavs, sr = self._base.generate_voice_clone(text=[audition_text], language=[lang], voice_clone_prompt=prompt)
    return SynthResult(pcm=_float_audio_to_int16_le(wavs[0]), sample_rate=int(sr))
```

- [ ] **Step 4: Run → pass.** The two non-GPU tests PASS (no weights needed).

- [ ] **Step 5: Weights-gated identity regression (the fs-55 acceptance)**

```python
from conftest import _qwen_weights_present
@pytest.mark.skipif(not _qwen_weights_present(), reason="weights absent")
def test_minted_variant_holds_base_identity():
    eng = main.ENGINES["qwen"]
    eng.design_voice("rv1", "A warm mid-30s British female narrator.", "English", None, None)
    eng.mint_variant("rv1", "rv1__angry", "Delivered angrily, with raised intensity and edge.", "English", None, None)
    base, lang, _ = eng._load_voice_prompt("rv1"); var, _, _ = eng._load_voice_prompt("rv1__angry")
    bw, bsr = eng._base.generate_voice_clone(text=["Stop right there."], language=[lang], voice_clone_prompt=base)
    vw, vsr = eng._base.generate_voice_clone(text=["Stop right there."], language=[lang], voice_clone_prompt=var)
    assert eng.speaker_distance(bw[0], bsr, vw[0], vsr) < 0.30  # threshold calibrated in Step 6
```

- [ ] **Step 6: Calibrate the threshold (operator, GPU box)** — mint 2-3 voices × 4 emotions; print `speaker_distance(base, variant)` AND **listen**; set the assert just above the worst *good* case; record numbers in Ship Notes (M7 calibration).

- [ ] **Step 7: Commit**
```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(side): anchored emotion-variant minting from base identity (fs-55)"
```

---

### Task 5: Sidecar route `/qwen/mint-variant`

**Files:** Modify `server/tts-sidecar/main.py` (route near `/qwen/design-voice` ~3219); Test `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:** `POST /qwen/mint-variant` body `{ baseVoiceId, variantVoiceId, emotionInstruct, language?, calibrationText?, voiceUuid? }` → audition PCM (same wire shape as `/qwen/design-voice`). `409` when the base isn't designed (`VoiceNotDesignedError`). Variant *preview* ids are passed verbatim as `variantVoiceId` (the Node side suffixes `-preview`); the route always anchors to the **real** `baseVoiceId`.

- [ ] **Step 1: Failing tests (validation + base-absent 409)** using inline `TestClient(main.app)`:

```python
def test_mint_variant_route_requires_fields(fake_qwen_runtime):
    c = TestClient(main.app)
    assert c.post("/qwen/mint-variant", json={"emotionInstruct": "x"}).status_code == 400

def test_mint_variant_route_409_when_base_absent(fake_qwen_runtime):
    c = TestClient(main.app)
    r = c.post("/qwen/mint-variant", json={"baseVoiceId": "nope", "variantVoiceId": "nope__sad", "emotionInstruct": "Delivered sadly."})
    assert r.status_code == 409
```

- [ ] **Step 2: Run → fail.** → FAIL (route missing).

- [ ] **Step 3: Implement the route** (mirror `/qwen/design-voice` ~3219): validate `baseVoiceId`/`variantVoiceId`/`emotionInstruct`; `try: await asyncio.to_thread(qwen.mint_variant, ...)` ; `except VoiceNotDesignedError: return JSONResponse({"detail": ...}, status_code=409)`; return PCM `Response`. Cancellation: the Node side already wraps design calls in its liveness/abort harness (`qwen-voice.ts:319-347`) — mint reuses it (Task 6), so no new sidecar-side abort needed.

- [ ] **Step 4: Run → pass.** Both tests PASS.

- [ ] **Step 5: Commit**
```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(side): POST /qwen/mint-variant route (409 on undesigned base) (fs-55)"
```

---

### Task 6: Route Node variant designs through the anchored path (incl. preview)

**Files:** Modify `server/src/routes/qwen-voice.ts` (`designQwenVoiceForCharacter` ~304-430); Test `server/src/routes/qwen-voice.test.ts`. **NOTE:** `designQwenVoiceForCharacter` is the SHARED core also called by the bulk "Design full cast" job (`cast-design.ts:246`, `emotion` set, `preview` undefined → non-preview id), so the bulk variant path inherits this change automatically (desired). No `cast-design.ts` code change needed, but **run `cast-design.test.ts` and confirm it stays green** (its variant designs now hit `/qwen/mint-variant`).

**Interfaces:** When `p.emotion` is set, POST `/qwen/mint-variant` with `{ baseVoiceId, variantVoiceId, emotionInstruct: EMOTION_INSTRUCT[emotion], language, calibrationText, voiceUuid }`. `baseVoiceId` = the **real** (non-preview) base storage key; `variantVoiceId` = `previewVoiceIdFor(\`${base}__${emotion}\`)` when `p.preview`, else `\`${base}__${emotion}\``. Base designs (no emotion) stay on `/qwen/design-voice`. Returned `{ voiceId, url }` unchanged.

- [ ] **Step 1: Failing test (supertest + fetchMock, real route)**

```ts
it('designs an emotion variant via /qwen/mint-variant anchored to the real base (fs-55)', async () => {
  fetchMock.mockResolvedValueOnce(new Response(Buffer.from(new Int16Array([1,2,3]).buffer), {
    status: 200, headers: { 'X-Sample-Rate': '24000', 'Content-Type': 'audio/L16;rate=24000' },
  }));
  await request(app)
    .post(`/api/books/${bookId}/cast/maerin/design-voice`)
    .send({ modelKey: QWEN_KEY, sampleVoiceId: 'char-maerin', emotion: 'angry' })
    .expect(200);
  const url = fetchMock.mock.calls.at(-1)![0] as string;
  expect(url).toContain('/qwen/mint-variant');
  const body = JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);
  expect(body.variantVoiceId).toMatch(/__angry$/);
  expect(body.baseVoiceId).not.toMatch(/__angry/);          // anchored to the REAL base
  expect(body.emotionInstruct).toBe('Delivered angrily, with raised intensity and edge.');
});
```

- [ ] **Step 2: Run → fail.** `cd server && npm run test -- qwen-voice` → FAIL (still hits `/qwen/design-voice`).

- [ ] **Step 3: Implement the branch** in `designQwenVoiceForCharacter`: compute `baseVoiceId = qwenStorageKey(...)`; `designedId = \`${baseVoiceId}__${emotion}\``; `variantVoiceId = p.preview ? previewVoiceIdFor(designedId) : designedId`; target `/qwen/mint-variant`; send `emotionInstruct: EMOTION_INSTRUCT[p.emotion]` (delivery clause only — base persona is already in the base identity), keep `language`/`calibrationText`/`voiceUuid`. Leave the no-emotion path on `/qwen/design-voice`. Keep the returned `voiceId` = `variantVoiceId` so the audition-cache key (`qwen-voice.ts:398-403`) is unchanged for variants.

- [ ] **Step 4: Run → pass.** Variant + the existing base-design tests PASS.

- [ ] **Step 5: Run full server suite + commit**
```bash
cd server && npm run test
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "feat(srv): route emotion-variant design through anchored /qwen/mint-variant, incl. preview (fs-55)"
```

---

### Task 7: Re-mint migration for existing books (can ship after Tasks 0-6)

**Files:** Create `scripts/remint-anchored-variants.mjs` (dry-run + `--apply`); Test `scripts/tests/remint-anchored-variants.test.mjs`

**Interfaces:** `planRemints(voices: {voiceId, mintMethod?}[]) -> string[]` — variant ids (`__emotion`) whose `.json` lacks `mintMethod === 'anchored-icl-instruct'`.

- [ ] **Step 1: Failing test**
```js
import { planRemints } from '../remint-anchored-variants.mjs';
test('selects only legacy (non-anchored) variants', () => {
  assert.deepEqual(planRemints([
    { voiceId: 'q-a' }, { voiceId: 'q-a__angry' },
    { voiceId: 'q-b__sad', mintMethod: 'anchored-icl-instruct' },
  ]), ['q-a__angry']);
});
```
- [ ] **Step 2: Run → fail. Step 3: implement `planRemints` + the dry-run/`--apply` driver (POSTs `/qwen/mint-variant` per legacy variant, anchored to its base). Step 4: run → pass.**
- [ ] **Step 5: Commit** `chore(scripts): re-mint legacy emotion variants to the anchored pipeline (fs-55)`

---

## Part B — 1.7B-Base selectable Quality synth tier (fs-56 slice, folded in 2026-06-22)

Per operator decision, expose the 1.7B-Base as a **per-character-selectable synth tier** (higher-quality clone). Independent of the drift fix (Tasks 1–7) — but shares the 1.7B-Base + the loader/lifecycle from Task 1. Lazy per-voice prompt derivation (decode the voice's 0.6B `.pt` `ref_code` → re-derive on the 1.7B → cache `<voice>__1.7b.pt`).

### Task 8: Add `qwen3-tts-1.7b` model key + selection

**Files:** Modify `server/src/tts/model-keys.ts`; Test `server/src/tts/index.test.ts`

**Interfaces:** Produces the `qwen3-tts-1.7b` `TtsModelKey` → engine `qwen`, `sidecarModelId` → `"1.7b"`.

- [ ] **Step 1: Failing tests (index.test.ts)** — add: `engineForModelKey('qwen3-tts-1.7b') === 'qwen'`; `sidecarModelId('qwen3-tts-1.7b') === '1.7b'`; `isTtsModelKey('qwen3-tts-1.7b') === true`.
- [ ] **Step 2: Run → fail.** `cd server && npm run test -- index` → FAIL.
- [ ] **Step 3: Implement in `model-keys.ts`:** add `'qwen3-tts-1.7b'` to the `TtsModelKey` union (~27); `TTS_MODEL_LABELS` entry `'Qwen3-TTS 1.7B (local, higher quality)'` (~35); `isTtsModelKey` check (~58); `sidecarModelId` → `if (key === 'qwen3-tts-1.7b') return '1.7b';` (~104); fix `canonicalModelKeyForEngine` qwen case (~86) to **preserve the qwen variant**: `case 'qwen': return requestModelKey.startsWith('qwen') ? requestModelKey : 'qwen3-tts-0.6b';`. (`engineForModelKey` already routes `qwen*` → `'qwen'`.)
- [ ] **Step 4: Run → pass.** Same command → PASS.
- [ ] **Step 5: Commit** `feat(srv): qwen3-tts-1.7b model key + selection plumbing (fs-56 Quality tier)`

### Task 9: Sidecar 1.7B synth routing + lazy 1.7B-native prompt

**Files:** Modify `server/tts-sidecar/main.py` (`QwenEngine.synthesize` ~1651, new `_load_voice_prompt_17b`); Test `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:** `QwenEngine._load_voice_prompt_17b(voice) -> (prompt, lang, cache_hit)` — caches `<voice>__1.7b.pt`, deriving it on miss from the 0.6B `.pt`'s `ref_code`. `synthesize(model, voice, text)` routes `model == '1.7b'` to `_base17` with that prompt.

- [ ] **Step 1: Non-GPU test (fake_qwen_runtime + spies)** — `synthesize('1.7b', voice, text)` calls `_ensure_base17_loaded`, derives+caches `<voice>__1.7b.pt` on first call (a `<voice>__1.7b.pt` file appears), reuses it on the second (no re-derive), and synths via `_base17.generate_voice_clone`. Use the same `_load_voice_prompt` stub pattern as Task 4 (base item with `ref_code`).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** Add `_load_voice_prompt_17b(voice)`: return cached `<voice>__1.7b.pt` if present (via `_voice_paths(f"{voice}__1.7b")`); else load the base prompt (`_load_voice_prompt(voice)`), `rc = base_item.ref_code`, decode on `_base17.model.speech_tokenizer`, `_base17.create_voice_clone_prompt(ref_audio=(clip,sr), ref_text=...)`, `torch.save` to `<voice>__1.7b.pt`, return it. In `synthesize`, when the sidecar `model` arg is `'1.7b'`: `_ensure_base17_loaded()`; `prompt,lang,_ = _load_voice_prompt_17b(voice)`; under `_synth_lock` `wavs,sr = self._base17.generate_voice_clone(text=[text], language=[lang], voice_clone_prompt=prompt)`. Else keep the 0.6B path. (Note: 1.7B synth keeps `_base17` resident during a 1.7B-tier chapter — ~4.2 GB, within budget; the design-time mint still unloads it.)
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Weights-gated test** (`@skipif not _qwen_weights_present`): a designed voice synths on `model='1.7b'`, produces audio, and the `<voice>__1.7b.pt` cache appears.
- [ ] **Step 6: Commit** `feat(side): 1.7B-Base synth routing + lazy per-voice 1.7B prompt cache (fs-56 Quality tier)`

### Task 10: Node synth routing + per-character 1.7B selection

**Files:** Modify `server/src/tts/synthesise-chapter.ts` (`CastCharacter` ~200-249, `routeFor` ~742), `src/components/voice-engine-picker.tsx`; Test `server/src/tts/synthesise-chapter.test.ts`

**Interfaces:** `CastCharacter.ttsModelKey?: TtsModelKey | null`; when set (and engine resolves to qwen), the group routes with that `modelKey` → sidecar `model:'1.7b'`.

- [ ] **Step 1: Failing test (synthesise-chapter.test.ts)** — a character with `ttsModelKey: 'qwen3-tts-1.7b'` produces a synth call whose `modelKey` is `'qwen3-tts-1.7b'` (and a 0.6B/default character still routes `'qwen3-tts-0.6b'`).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** Add `ttsModelKey?: TtsModelKey | null` to `CastCharacter`; in `routeFor` (~742), when the resolved engine is `'qwen'` and `c.ttsModelKey` is set, use `canonicalModelKeyForEngine('qwen', c.ttsModelKey)` as the `modelKey` (else the default `qwen3-tts-0.6b`). In `voice-engine-picker.tsx`, when Qwen is chosen and the 1.7B-Base is installed (health `qwen_base17_*`), add a "Higher quality (1.7B)" toggle that writes `ttsModelKey: 'qwen3-tts-1.7b'` (else clears it).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** `feat(srv,fe): per-character 1.7B Quality-tier selection + synth routing (fs-56)`

---

### Task 11: Verify, document, close (fs-55 + 1.7B Quality tier)

- [ ] **Step 0: Rebase the worktree on `main`** (once network's back) so the spec (#1002) is present: `git fetch origin main && git rebase origin/main` (resolve any `BACKLOG.md`/spec overlap). Confirm `docs/superpowers/specs/2026-06-22-expressive-tts-instruct-tiers-design.md` now exists.
- [ ] **Step 1:** `npm run verify:fast` (frontend + server: model-keys, synth-routing, qwen-voice, pill tests) + `npm run test:hooks` (the install `.mjs` test); on the GPU box `npm run test:sidecar` (the fs-55 identity regression AND the 1.7B-synth/prompt-cache weights-gated tests must PASS, not skip). **Operator listens once to the whole thing** (drift-fixed variants + a 1.7B-tier chapter) — final intensity call on whisper/angry here.
- [ ] **Step 1b — exercise the re-mint migration on the bundled sample book (Coalfall):** with the sidecar up (0.6B + 1.7B-Base), run `node scripts/remint-anchored-variants.mjs` (dry-run) against the Coalfall sample voices (`samples/the-coalfall-commission/voices/qwen/`) and confirm it lists the existing legacy (pre-anchored) variants. Then `--apply` and re-listen to one re-minted variant to confirm an EXISTING book's drifted variant is now the same person as its base. (Back up `voices/qwen/` first — the script overwrites in place.)
- [ ] **Step 2:** Fill **Ship Notes**: SHA, calibrated threshold + per-emotion distances, on-box verify result, Task-0 smoke output.
- [ ] **Step 3:** Update the spec §4.4 precedence ladder (emotion/instruct/manual) + §4.5 carve-out note; remove fs-55's spec caveat now that it's measured.
- [ ] **Step 4:** PR title `feat(srv,side,fe): anchored variant minting (fs-55) + selectable 1.7B Quality tier (fs-56)`; body `Closes #993` (operator-confirmed: close the fs-55 *detection-gate feature* as obviated by prevention) + `Refs #996` (fs-56 — this delivers the Quality-tier slice; instruct/non-verbal remain). Open as **draft**; `gh pr ready` once locally green.

## Ship Notes

_(fill on ship: SHA · calibrated identity threshold + per-emotion cosine distances · Task-0 smoke output · on-box verify result.)_

## Open items carried from the spec (NOT this plan)

- **R2-M4** (instruct-token batch bucketing) + **R2-M5** (0.6B↔1.7B base-swap policy) → the **fs-56** instruct-feature plan (this fix only touches *design-time* minting, never the per-line synth batcher).
- **C2** broad validation + the committed perf benchmark → fs-56 wave-0 gates (Task 0 here is the narrower variant-specific smoke, not the full matrix).
