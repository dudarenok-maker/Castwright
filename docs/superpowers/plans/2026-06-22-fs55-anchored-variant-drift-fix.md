# fs-55 — Anchored Emotion-Variant Drift Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Qwen emotion-variant voices (`<base>__angry`, `__sad`, `__excited`, `__whisper`) from drifting to a different-sounding person by minting each variant **from the base voice's own identity** instead of independently re-sampling VoiceDesign.

**Architecture:** Base voices keep today's `design_voice` path (VoiceDesign persona → 0.6B clone — a single base never drifts). **Variants** switch to a new anchored path: load the base's on-disk `.pt`, decode its `ref_code` → reference clip, re-derive a **1.7B-Base ICL** prompt, synth *the base voice performing the emotion* via the raw-`generate` clone+instruct bypass, then distil that emotion clip to a **0.6B ICL `.pt`**. Every variant now shares the base identity → drift gone by construction. Resolves **fs-55 (#993)**.

**Tech Stack:** Python TTS sidecar (`server/tts-sidecar/main.py`, `qwen_tts` 0.1.1, torch 2.11/cu128), Node/Express server (`server/src/routes/qwen-voice.ts`, `cast-design.ts`), pytest + vitest.

## Global Constraints

- **Installed `qwen-tts` is 0.1.1** — the raw `Qwen3TTSForConditionalGeneration.generate()` accepts both `voice_clone_prompt` and `instruct_ids` in independent additive branches (`modeling_qwen3_tts.py:2022-2080`); the public wrapper never wires them together, so we call `self._base17.model.generate(...)` directly. **Pin `qwen-tts` and add a guard test** (R2-M2) — the bypass depends on internals.
- **VRAM invariant (hard):** never two heavy models co-resident. During minting: do all 1.7B-Base work, **unload the 1.7B**, then load the 0.6B for the distil. Variant `.pt` **must** be ICL (emotion lives in `ref_code`; x-vector-only loses it).
- **0.6B-designed `.pt` is dim-incompatible with the 1.7B** (1024 vs 2048 speaker-embedding); the base prompt **must be re-derived** on the 1.7B from the decoded `ref_code`, never loaded directly.
- **Name/contract stability:** variant voiceId stays `${baseVoiceId}__${emotion}`; `.pt`/`.json` paths via `_voice_paths` unchanged; the existing emotion-suffix map and `persistEmotionVariant` cast wiring stay as-is.
- **Sidecar tests are venv/weights-gated** — GPU-dependent tests SKIP+exit-0 when the venv/weights are absent (existing `test:sidecar` convention).
- Spec: `docs/superpowers/specs/2026-06-22-expressive-tts-instruct-tiers-design.md` (§4.2, §4.3, §11 R2-C2).

---

### Task 1: Wire Qwen 1.7B-Base into setup (side-20 #999)

**Files:**
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs` (model consts ~66-68; prefetch list ~257)
- Modify: `server/tts-sidecar/main.py` (`QwenEngine` model-id consts + a `_base17` loader, near the existing `_ensure_base_loaded` ~1284)
- Test: `scripts/tests/install-qwen3-base17.test.mjs` (new) + `server/tts-sidecar/tests/test_qwen3.py` (loader id)

**Interfaces:**
- Produces: `QwenEngine.BASE17_MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"`; `QwenEngine._ensure_base17_loaded() -> None` (loads the 1.7B Base into `self._base17`, mirroring `_ensure_base_loaded`); `QwenEngine.unload_base17() -> None`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test for the install model-list helper**

Extract the prefetch list into a pure helper first (mirrors the existing `qwenPipInstallArgs` / `resolveFlashAttnInstall` testable-helper pattern). Test:

```js
// scripts/tests/install-qwen3-base17.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qwenPrefetchModels } from '../../server/tts-sidecar/scripts/install-qwen3.mjs';

test('1.7B-Base is prefetched alongside Base + VoiceDesign by default', () => {
  const ids = qwenPrefetchModels({ skipDesign: false });
  assert.ok(ids.includes('Qwen/Qwen3-TTS-12Hz-1.7B-Base'), '1.7B-Base must be fetched');
  assert.ok(ids.includes('Qwen/Qwen3-TTS-12Hz-0.6B-Base'));
  assert.ok(ids.includes('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'));
});

test('--skip-design still fetches both Base models (needed for variant minting)', () => {
  const ids = qwenPrefetchModels({ skipDesign: true });
  assert.ok(ids.includes('Qwen/Qwen3-TTS-12Hz-1.7B-Base'));
  assert.ok(ids.includes('Qwen/Qwen3-TTS-12Hz-0.6B-Base'));
  assert.ok(!ids.includes('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'));
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test scripts/tests/install-qwen3-base17.test.mjs`
Expected: FAIL — `qwenPrefetchModels` is not exported.

- [ ] **Step 3: Add the helper + 1.7B-Base const in `install-qwen3.mjs`**

```js
// near the model consts (~line 66)
const BASE_17B_MODEL = process.env.QWEN_BASE_17B_MODEL || 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';

/** Pure: the model ids to prefetch. 1.7B-Base is required for fs-55 anchored
 *  variant minting, so it is fetched even with --skip-design. */
export function qwenPrefetchModels({ skipDesign }) {
  const ids = [BASE_MODEL, BASE_17B_MODEL];
  if (!skipDesign) ids.push(VOICEDESIGN_MODEL);
  return ids;
}
```

Then replace the inline `models` array in `main()` (~257) with `const models = qwenPrefetchModels({ skipDesign: SKIP_DESIGN });` and update the size hint string to mention `+ ~3.4 GB 1.7B-Base`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test scripts/tests/install-qwen3-base17.test.mjs`
Expected: PASS (both tests).

- [ ] **Step 5: Add the `_base17` loader to `QwenEngine` (main.py)**

Mirror `_ensure_base_loaded`/`_load_model`. Add near line 1284:

```python
BASE17_MODEL = os.environ.get("QWEN_BASE_17B_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")

def _ensure_base17_loaded(self) -> None:
    """Load the 1.7B Base (anchored-variant minting only). Heavy — callers
    unload it before any 0.6B work to keep the one-heavy-model invariant."""
    if self._base17 is not None:
        return
    self._base17 = self._load_model(self.BASE17_MODEL)  # reuses the shared loader

def unload_base17(self) -> None:
    with self._synth_lock:
        self._base17 = None
    _reclaim_host_and_vram()
```

Initialise `self._base17 = None` in `__init__` alongside `self._base`/`self._design`.

- [ ] **Step 6: Add a weights-gated loader test (test_qwen3.py)**

```python
@pytest.mark.skipif(not _qwen_weights_present(), reason="1.7B-Base weights absent")
def test_ensure_base17_loads_a_base_checkpoint(qwen_engine):
    qwen_engine._ensure_base17_loaded()
    assert qwen_engine._base17 is not None
    assert getattr(qwen_engine._base17.model, "tts_model_type", None) == "base"
    qwen_engine.unload_base17()
    assert qwen_engine._base17 is None
```

- [ ] **Step 7: Run sidecar tests + commit**

Run: `npm run test:sidecar` (SKIPs the gated test on a box without weights — that's expected).
```bash
git add server/tts-sidecar/scripts/install-qwen3.mjs scripts/tests/install-qwen3-base17.test.mjs server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(side): wire Qwen 1.7B-Base into setup + QwenEngine loader (side-20)"
```

---

### Task 2: Raw-`generate` ICL + instruct synth helper (the §4.2 bypass)

**Files:**
- Modify: `server/tts-sidecar/main.py` (`QwenEngine`, new method near `synthesize` ~1651)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Consumes: `_ensure_base17_loaded` (Task 1).
- Produces: `QwenEngine._icl_instruct_synth(prompt_items: list, text: str, instruct: str, lang: str) -> tuple[np.ndarray, int]` — runs `self._base17.model.generate(input_ids, ref_ids, instruct_ids, voice_clone_prompt)` and returns `(wav, sample_rate)` with the ICL ref-prefix trimmed. Used by Task 4.

- [ ] **Step 1: Write the failing test (instruct_ids/ref_ids construction, model mocked)**

```python
def test_icl_instruct_synth_builds_instruct_and_ref_ids(qwen_engine, monkeypatch):
    captured = {}
    class _FakeBase17:
        class model:
            @staticmethod
            def generate(**kw):
                captured.update(kw)
                return ([_fake_codes()], None)
            speech_tokenizer = _FakeTokenizer()  # .decode -> ([wav], 24000)
    qwen_engine._base17 = _FakeBase17()
    monkeypatch.setattr(qwen_engine, "_ensure_base17_loaded", lambda: None)
    item = _FakePromptItem(voice_marker=_fake_codes(), ref_text="calib")
    wav, sr = qwen_engine._icl_instruct_synth([item], "Hello.", "Delivered angrily.", "English")
    assert "instruct_ids" in captured and captured["instruct_ids"][0] is not None
    assert "ref_ids" in captured and "voice_clone_prompt" in captured
    assert sr == 24000
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `python -m pytest server/tts-sidecar/tests/test_qwen3.py::test_icl_instruct_synth_builds_instruct_and_ref_ids -v`
Expected: FAIL — `_icl_instruct_synth` not defined.

- [ ] **Step 3: Implement `_icl_instruct_synth` (replicates the wrapper's ICL handling + adds instruct_ids)**

```python
def _icl_instruct_synth(self, prompt_items, text, instruct, lang):
    """Synth `text` in the ICL-cloned identity of `prompt_items` while obeying
    `instruct`, via the raw generate() additive branches (clone + instruct).
    1.7B-Base only. Mirrors generate_voice_clone's ICL ref-prefix trim."""
    w = self._base17                      # qwen_tts wrapper
    m = w.model
    vcp = w._prompt_items_to_voice_clone_prompt(prompt_items)
    input_ids = w._tokenize_texts([w._build_assistant_text(text)])
    rt = getattr(prompt_items[0], "ref_text", None)
    ref_ids = [w._tokenize_texts([w._build_ref_text(rt)])[0]] if rt else [None]
    instruct_ids = w._tokenize_texts([w._build_instruct_text(instruct)])
    gen_kwargs = w._merge_generate_kwargs()
    import torch
    with torch.no_grad():
        codes, _ = m.generate(
            input_ids=input_ids, ref_ids=ref_ids, instruct_ids=instruct_ids,
            voice_clone_prompt=vcp, languages=[lang], non_streaming_mode=True, **gen_kwargs,
        )
    rcl = vcp.get("ref_code")
    cfd = [torch.cat([rcl[i].to(c.device), c], dim=0) if rcl and rcl[i] is not None else c
           for i, c in enumerate(codes)]
    wavs, sr = m.speech_tokenizer.decode([{"audio_codes": c} for c in cfd])
    wav = wavs[0]
    if rcl and rcl[0] is not None:
        cut = int(int(rcl[0].shape[0]) / max(int(cfd[0].shape[0]), 1) * wav.shape[0])
        wav = wav[cut:]
    return wav, int(sr)
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `python -m pytest server/tts-sidecar/tests/test_qwen3.py::test_icl_instruct_synth_builds_instruct_and_ref_ids -v`
Expected: PASS.

- [ ] **Step 5: Add the qwen-tts version-pin guard test (R2-M2)**

```python
def test_qwen_tts_pinned_version_for_raw_bypass():
    import qwen_tts
    # The raw-generate clone+instruct bypass depends on 0.1.x internals.
    assert qwen_tts.__version__.startswith("0.1."), (
        f"qwen-tts {qwen_tts.__version__} — re-verify the raw generate() "
        "clone+instruct branches before bumping (fs-55 / spec R2-M2)."
    )
```

Also pin `qwen-tts==0.1.1` in `server/tts-sidecar/requirements/base.txt` if not already exact-pinned.

- [ ] **Step 6: Run + commit**

Run: `npm run test:sidecar`
```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py server/tts-sidecar/requirements/base.txt
git commit -m "feat(side): raw-generate ICL+instruct synth helper + qwen-tts pin guard (fs-55)"
```

---

### Task 3: ECAPA identity-distance helper + the fs-55 regression metric (M7)

**Files:**
- Modify: `server/tts-sidecar/main.py` (`QwenEngine`, small helper)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Produces: `QwenEngine.speaker_distance(wav_a, sr_a, wav_b, sr_b) -> float` — cosine distance (0 = identical speaker) between two clips' ECAPA embeddings via the Base model's `extract_speaker_embedding`. Used by Task 4's regression.
- Module-level pure: `cosine_distance(a, b) -> float`.

- [ ] **Step 1: Write the failing test for the pure cosine helper**

```python
import numpy as np
def test_cosine_distance_pure():
    from main import cosine_distance
    v = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    assert cosine_distance(v, v) == pytest.approx(0.0, abs=1e-6)
    assert cosine_distance(v, np.array([0.0, 1.0, 0.0], np.float32)) == pytest.approx(1.0, abs=1e-6)
```

- [ ] **Step 2: Run to confirm fail**

Run: `python -m pytest server/tts-sidecar/tests/test_qwen3.py::test_cosine_distance_pure -v`
Expected: FAIL — `cosine_distance` not defined.

- [ ] **Step 3: Implement `cosine_distance` (module level) + `speaker_distance` (engine)**

```python
def cosine_distance(a, b) -> float:
    import numpy as np
    a = np.asarray(a, dtype=np.float64).ravel(); b = np.asarray(b, dtype=np.float64).ravel()
    denom = (np.linalg.norm(a) * np.linalg.norm(b)) or 1.0
    return float(1.0 - (a @ b) / denom)
```

```python
def speaker_distance(self, wav_a, sr_a, wav_b, sr_b) -> float:
    """ECAPA cosine distance between two clips (0 = same speaker). 0.6B Base."""
    self._ensure_base_loaded()
    m = self._base.model
    ea = m.extract_speaker_embedding(audio=_resample24k(wav_a, sr_a), sr=24000)
    eb = m.extract_speaker_embedding(audio=_resample24k(wav_b, sr_b), sr=24000)
    return cosine_distance(ea.detach().cpu().numpy(), eb.detach().cpu().numpy())
```

(`_resample24k` — small librosa/torchaudio helper; `extract_speaker_embedding` asserts sr==24000.)

- [ ] **Step 4: Run to confirm pass**

Run: `python -m pytest server/tts-sidecar/tests/test_qwen3.py::test_cosine_distance_pure -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(side): ECAPA speaker-distance helper for the fs-55 identity regression (M7)"
```

---

### Task 4: Anchored variant minting (`mint_variant`)

**Files:**
- Modify: `server/tts-sidecar/main.py` (`QwenEngine`, new method near `design_voice` ~1493)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Consumes: `_load_voice_prompt` (base `.pt`), `_ensure_base17_loaded`/`unload_base17`, `_icl_instruct_synth` (Task 2), `create_voice_clone_prompt` (0.6B), `speaker_distance` (Task 3), `_voice_paths`.
- Produces: `QwenEngine.mint_variant(base_voice_id, variant_voice_id, emotion_instruct, language, calibration_text, voice_uuid) -> SynthResult` — writes the anchored variant `.pt`/`.json`, returns an audition preview.

- [ ] **Step 1: Write the failing weights-gated regression (variant ≈ base identity)**

```python
@pytest.mark.skipif(not _qwen_weights_present(), reason="Qwen weights absent")
def test_minted_variant_holds_base_identity(qwen_engine, tmp_voices_dir):
    # design a base voice, then mint an "angry" variant from it
    qwen_engine.design_voice("v1", "A warm mid-30s British female narrator.", "English", None, None)
    qwen_engine.mint_variant("v1", "v1__angry", "Delivered angrily, with raised intensity and edge.",
                             "English", None, None)
    base, lang, _ = qwen_engine._load_voice_prompt("v1")
    var, _, _ = qwen_engine._load_voice_prompt("v1__angry")
    # synth the same line on both, compare speaker identity
    bw, bsr = qwen_engine._base.generate_voice_clone(text=["Stop right there."], language=[lang], voice_clone_prompt=base)
    vw, vsr = qwen_engine._base.generate_voice_clone(text=["Stop right there."], language=[lang], voice_clone_prompt=var)
    dist = qwen_engine.speaker_distance(bw[0], bsr, vw[0], vsr)
    assert dist < 0.30, f"variant drifted from base (cosine {dist:.3f})"  # threshold calibrated in Step 6
```

- [ ] **Step 2: Run to confirm fail**

Run: `python -m pytest server/tts-sidecar/tests/test_qwen3.py::test_minted_variant_holds_base_identity -v`
Expected: FAIL — `mint_variant` not defined (or SKIP if no weights — run on the GPU box).

- [ ] **Step 3: Implement `mint_variant`**

```python
def mint_variant(self, base_voice_id, variant_voice_id, emotion_instruct,
                 language, calibration_text, voice_uuid=None) -> "SynthResult":
    """Mint an emotion variant ANCHORED to an already-designed base voice.
    base ref_code -> reference clip -> 1.7B-Base ICL re-derive -> instruct-synth
    the base voice performing the emotion -> distil to a 0.6B ICL .pt."""
    import torch
    lang = (language or self.DEFAULT_LANGUAGE).strip() or self.DEFAULT_LANGUAGE
    ref_text = self.CALIBRATION_TEXT
    audition_text = (calibration_text or self.CALIBRATION_TEXT).strip() or self.CALIBRATION_TEXT

    base_prompt, _blang, _ = self._load_voice_prompt(base_voice_id)
    base_item = (base_prompt if isinstance(base_prompt, list) else [base_prompt])[0]

    # --- 1.7B phase: decode base ref_code -> clip -> ICL re-derive -> instruct synth ---
    with _VD_KOKORO.design():
        self._ensure_base17_loaded()
        with self._synth_lock:
            self._ensure_base17_loaded()
            rc = base_item.ref_code
            rc = rc.to(self._device) if hasattr(rc, "to") else rc
            ref_wavs, ref_sr = self._base17.model.speech_tokenizer.decode([{"audio_codes": rc}])
            icl = self._base17.create_voice_clone_prompt(ref_audio=(ref_wavs[0], ref_sr), ref_text=ref_text)
            icl = icl if isinstance(icl, list) else [icl]
            emo_wav, emo_sr = self._icl_instruct_synth(icl, ref_text, emotion_instruct, lang)
    self.unload_base17()                      # one-heavy-model invariant

    # --- 0.6B phase: distil the emotion clip into a variant .pt ---
    with self._synth_lock:
        self._ensure_base_loaded()
        prompt = self._base.create_voice_clone_prompt(ref_audio=(emo_wav, emo_sr), ref_text=ref_text)

    os.makedirs(self._voices_dir, exist_ok=True)
    pt_path, json_path = self._voice_paths(variant_voice_id)
    torch.save(prompt, pt_path)
    import json as _json
    with open(json_path, "w", encoding="utf-8") as fh:
        _json.dump({
            "voiceId": variant_voice_id, "voiceUuid": voice_uuid,
            "instruct": emotion_instruct, "language": lang, "refText": ref_text,
            "baseModel": self.BASE_MODEL, "designModel": self.BASE17_MODEL,
            "anchoredTo": base_voice_id, "mintMethod": "anchored-icl-instruct",  # fs-55 marker
        }, fh, ensure_ascii=False, indent=2)
    with self._cache_lock:
        self._prompt_cache.pop(variant_voice_id, None)

    with self._synth_lock:
        self._ensure_base_loaded()
        wavs, sr = self._base.generate_voice_clone(text=[audition_text], language=[lang], voice_clone_prompt=prompt)
    return SynthResult(pcm=_float_audio_to_int16_le(wavs[0]), sample_rate=int(sr))
```

- [ ] **Step 4: Run the regression on the GPU box**

Run: `npm run test:sidecar` (on the box with weights)
Expected: `test_minted_variant_holds_base_identity` PASS (distance < threshold). If it SKIPs, you are not on a weights box — this task MUST be run on one.

- [ ] **Step 5: Add a `.json` marker assertion (runs anywhere via the existing fakes)**

```python
def test_mint_variant_marks_json_anchored(qwen_engine_faked, tmp_voices_dir):
    qwen_engine_faked.mint_variant("v1", "v1__sad", "Delivered sadly.", "English", None, "uuid-1")
    import json
    meta = json.load(open(os.path.join(tmp_voices_dir, "v1__sad.json"), encoding="utf-8"))
    assert meta["anchoredTo"] == "v1" and meta["mintMethod"] == "anchored-icl-instruct"
    assert meta["voiceUuid"] == "uuid-1"
```

- [ ] **Step 6: Calibrate + record the identity threshold (operator, on the box)**

Mint variants for 2–3 designed voices × all 4 emotions; print `speaker_distance(base, variant)` for each AND **listen** to confirm "same person." Set the test's threshold just above the worst *good* case. Record the chosen number + the per-emotion distances in the plan's Ship Notes and as a comment on the threshold line. (This is the M7 "calibrate against perceived identity" step.)

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(side): anchored emotion-variant minting from base identity (fs-55)"
```

---

### Task 5: Sidecar route `/qwen/mint-variant`

**Files:**
- Modify: `server/tts-sidecar/main.py` (route, near `/qwen/design-voice` ~3219)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Consumes: `mint_variant` (Task 4).
- Produces: `POST /qwen/mint-variant` — body `{ baseVoiceId, variantVoiceId, emotionInstruct, language?, calibrationText?, voiceUuid? }`; returns audition PCM (same wire shape as `/qwen/design-voice`).

- [ ] **Step 1: Write the failing route test (validation)**

```python
def test_mint_variant_route_requires_base_and_variant(client):
    r = client.post("/qwen/mint-variant", json={"emotionInstruct": "x"})
    assert r.status_code == 400
```

- [ ] **Step 2: Run → fail.** Run: `python -m pytest server/tts-sidecar/tests/test_qwen3.py::test_mint_variant_route_requires_base_and_variant -v` → FAIL (404/405, route missing).

- [ ] **Step 3: Implement the route** (mirror `/qwen/design-voice`, validate `baseVoiceId`/`variantVoiceId`/`emotionInstruct`, dispatch `asyncio.to_thread(qwen.mint_variant, ...)`, return PCM Response).

- [ ] **Step 4: Run → pass.** Same command → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
git commit -m "feat(side): POST /qwen/mint-variant route (fs-55)"
```

---

### Task 6: Route Node variant designs through the anchored path

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (`designQwenVoiceForCharacter` ~304-430)
- Test: `server/src/routes/qwen-voice.test.ts` (the `fs-25 emotion variants` describe ~456)

**Interfaces:**
- Consumes: `/qwen/mint-variant` (Task 5).
- Produces: when `p.emotion` is set, `designQwenVoiceForCharacter` POSTs to `/qwen/mint-variant` with `{ baseVoiceId, variantVoiceId, emotionInstruct: EMOTION_INSTRUCT[emotion], language, calibrationText, voiceUuid }` instead of `/qwen/design-voice`. Base designs (no emotion) unchanged. Returned `{ voiceId, url }` shape unchanged.

- [ ] **Step 1: Update the failing test**

```ts
it('designs an emotion variant via /qwen/mint-variant anchored to the base (fs-55)', async () => {
  const fetchMock = mockSidecarOk();
  await designQwenVoiceForCharacter({ /* …, */ emotion: 'angry' });
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  expect(url).toContain('/qwen/mint-variant');
  const body = JSON.parse(init.body);
  expect(body.baseVoiceId).toBe(qwenStorageKey(character, characterId));
  expect(body.variantVoiceId).toBe(`${body.baseVoiceId}__angry`);
  expect(body.emotionInstruct).toBe('Delivered angrily, with raised intensity and edge.');
});
```

- [ ] **Step 2: Run → fail.** Run: `cd server && npm run test -- qwen-voice` → FAIL (still hits `/qwen/design-voice`).

- [ ] **Step 3: Implement the branch** in `designQwenVoiceForCharacter`: when `p.emotion`, build `baseVoiceId`/`variantVoiceId`, target `/qwen/mint-variant`, send `emotionInstruct: EMOTION_INSTRUCT[p.emotion]` (the delivery clause only — the base persona is already baked into the base identity), keep `language`/`calibrationText`/`voiceUuid`. Leave the no-emotion (base) path on `/qwen/design-voice`.

- [ ] **Step 4: Run → pass.** Same command → PASS; confirm the base-design test still passes.

- [ ] **Step 5: Update the spec's §4.4 precedence + §4.5 carve-out note (R2-Mo)** — add the explicit emotion/instruct/manual-edit precedence ladder and confirm Script Review (fs-58) won't strip vocalizations. (Doc-only; one paragraph each.)

- [ ] **Step 6: Run full server suite + commit**

Run: `cd server && npm run test`
```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts docs/superpowers/specs/2026-06-22-expressive-tts-instruct-tiers-design.md
git commit -m "feat(srv): route emotion-variant design through anchored /qwen/mint-variant (fs-55)"
```

---

### Task 7: Re-mint migration for existing books (follow-up — can ship after Tasks 1–6)

**Files:**
- Create: `scripts/remint-anchored-variants.mjs` (dry-run + `--apply`, per the repair-script convention)
- Test: `scripts/tests/remint-anchored-variants.test.mjs`

**Interfaces:**
- Produces: pure `planRemints(voices: {voiceId, mintMethod?}[]) -> string[]` returning variant voiceIds whose `.json` lacks `mintMethod === 'anchored-icl-instruct'` (i.e. old drifted variants). The script calls `/qwen/mint-variant` for each.

- [ ] **Step 1: Failing test for the pure planner**

```js
import { planRemints } from '../remint-anchored-variants.mjs';
test('selects only legacy (non-anchored) variants', () => {
  const got = planRemints([
    { voiceId: 'q-a', }, { voiceId: 'q-a__angry' }, // legacy variant -> remint
    { voiceId: 'q-b__sad', mintMethod: 'anchored-icl-instruct' }, // already anchored -> skip
  ]);
  assert.deepEqual(got, ['q-a__angry']);
});
```

- [ ] **Step 2: Run → fail. Step 3: implement `planRemints` + the dry-run/apply driver. Step 4: run → pass.**

- [ ] **Step 5: Commit**

```bash
git add scripts/remint-anchored-variants.mjs scripts/tests/remint-anchored-variants.test.mjs
git commit -m "chore(scripts): re-mint legacy emotion variants to the anchored pipeline (fs-55)"
```

---

### Task 8: Verify, document, close fs-55

- [ ] **Step 1:** Run the full fast battery: `npm run verify:fast`. On the GPU box also `npm run test:sidecar` (the gated identity regression must PASS, not skip).
- [ ] **Step 2:** Fill this plan's **Ship Notes** with the shipped SHA + the calibrated identity threshold + per-emotion distances.
- [ ] **Step 3:** Update `docs/BACKLOG.md`: fs-55's resolution lands here — leave fs-56's row (instruct feature) noting the anchored-variant sub-fix shipped early via this plan.
- [ ] **Step 4:** Open the PR with **`Closes #993`** (fs-55) and `Refs #996` (fs-56). PR title: `feat(srv,side): anchored emotion-variant minting — fix variant drift (fs-55)`.

## Ship Notes

_(fill on ship: SHA, calibrated identity threshold + per-emotion cosine distances, on-box verify result.)_

## Open items carried from the spec (not this plan)

- **R2-M4** (instruct-token batch bucketing) and **R2-M5** (0.6B↔1.7B base-swap policy) belong to the **fs-56 instruct-feature** plan, not this drift fix (this fix only touches *design-time* minting, never the per-line synth batcher).
- **C2** broad validation + the committed perf benchmark remain fs-56 wave-0 gates.
