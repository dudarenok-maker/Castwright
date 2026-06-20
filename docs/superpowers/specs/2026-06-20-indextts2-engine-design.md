# fs-49 — IndexTTS-2 expressive TTS engine (decoupled per-line emotion)

- **Date:** 2026-06-20
- **Issue:** _to be filed_ (`area:fs`, `moscow:could` — _auto-promotes to `should` iff the 8GB
  spike passes_, `type:feat`)
- **Branch:** _none yet — backlog item; spec only, no plan this round_
- **Status:** draft design (brainstormed from a cited research pass; **to be hardened over
  several adversarial review rounds**, like fs-48). A **sibling** to the parked Fish S2-Pro
  spec ([2026-06-20-fish-audio-s2pro-engine-design.md](2026-06-20-fish-audio-s2pro-engine-design.md));
  the two compete for the same "expressive perform engine" slot.
- **Provenance note:** every IndexTTS-2 fact below traces to a verified, adversarially-checked
  research pass (arXiv 2506.21619 v1/v2; the `index-tts/index-tts` repo + LICENSE; the
  `IndexTeam/IndexTTS-2` HuggingFace weights card; project page). Claims the research could **not**
  settle — chiefly the 8GB fit — are marked **unverified / spike-gated**, not asserted. Codebase
  seam names were checked against today's `main`; where a name is indicative it says so.

## Summary

Add **IndexTTS-2** (IndexTeam / bilibili; arXiv 2506.21619, mid-2025) as an **opt-in** synthesis
engine alongside Kokoro, Coqui XTTS, and Qwen. Its headline is the one capability our pipeline
most wants and does not have cheaply today: **decoupled, per-line emotional expression** —
**one** timbre, with emotion driven **at inference time, per sentence**, from data we already
compute. Qwen stays the default engine; IndexTTS-2 is the engine a user switches to when they
want stronger, finer expression.

Two things the research **verified** carry the lead:

1. **Decoupled per-line emotion is real and architecturally enforced.** IndexTTS-2 separates
   speaker timbre (`spk_audio_prompt`) from emotion (`emo_audio_prompt` / `emo_vector` /
   `emo_text`) — a Gradient Reversal Layer makes the emotion embedding invariant to timbre, and
   the emotion prompt may even come from a *different* speaker. This is exactly the
   "author timbre once, drive expression separately" shape we want.
2. **The license is permissive by default** — far lighter than Fish's Research License (Gate 2).

The one thing the research **could not verify** is the very thing that would make this a
must-build: **does it fit a consumer 8GB GPU.** No primary source discloses parameter count,
inference VRAM, quantization footprint, or RTF, and **no community quantization patch exists**.
So the **8GB-Qwen-beater thesis is an honest bet, not a fact** — it rides entirely on a
hardware spike (Gate 1). If the bet lands, this is a genuine upgrade on hardware our users
already own and the item is a **Should**. If it doesn't, it falls back to a 16GB-class **Could**
beside Fish.

**The design choice that gives the bet a chance is the same one that makes the integration
clean:** drive emotion from the **8-float vector** path (fed by our existing per-quote emotion
analysis) rather than IndexTTS-2's natural-language `emo_text` path — because `emo_text` loads a
**Qwen3-1.7B** sub-model, and the vector path does not. Skipping that 1.7B module is both the
tidiest fit to our data and the largest single VRAM lever (§"The 8GB bet").

## Why this is a Could-that-can-become-a-Should, and the gates

Stated up front so a future implementer inherits the framing.

### Gate 1 — 8GB feasibility (the promotion trigger AND the make-or-break)

This is the load-bearing unknown and it is **hardware-gated** (needs a physical 8GB card on our
pipeline) **and currently un-deskable** — no amount of further reading resolves it, because the
numbers were never published:

- **No total/per-module parameter count** in the paper, repo, or model card. Only architectural
  dims (T2S `model_dim` 1280 / 24 layers / 20 heads; S2M `hidden_dim` 512 / depth 13) — not
  parameter counts.
- **No measured inference VRAM, no quantization data, no RTF.** The only hardware figure anywhere
  is *training* (8× A100 80GB) — not inference.
- **The "8GB" figure that circulates online is for IndexTTS *1.5*, a different model** — do
  **not** assume it transfers to v2.
- **No community GGUF / int4 / FP8 patch** was found — so any sub-budget quant is a build cost we
  bear, not a download (contrast Fish, which had a community NF4 ecosystem to point at — on the
  VRAM-evidence axis IndexTTS-2 is **thinner** than Fish).
- **It is a four-stage stack:** T2S autoregressive transformer **+** S2M flow-matching **+**
  BigVGANv2 vocoder **+** (only if `emo_text` is used) a Qwen3-1.7B text-to-emotion module. Even
  excluding the 1.7B module this is not obviously an 8GB-class model co-resident with anything.

**The spike's job:** measure peak VRAM (vector-path, 1.7B module *not* loaded) and RTF for
chapter-length generation on a real 8GB card, **with the analyzer Ollama evicted** (the real 8GB
constraint — they evict each other today). **Pass ⇒ promote the item to Should.** Fail ⇒ §Fallback.

### Gate 2 — License (permissive by default; a lighter gate than Fish, not a zero gate)

The weights ship under a **custom source-available "bilibili Model Use License Agreement"**
(bilibili is the right-holder; IndexTeam is its internal dev team) — **not** Apache/MIT, **not**
CC-BY-NC. The code is Apache-2.0; the **weights** carry the bilibili license. The verified facts:

- **Commercial use — including audiobooks for sale — is permitted by default** for a small
  operator. §2.1 grants a "worldwide, non-exclusive, non-transferable, royalty-free limited
  license to Use"; the **only** scale restriction (§2.2) triggers a separate negotiated license
  **above >100M MAU or >RMB 1B annual revenue** — orders of magnitude beyond Castwright. The HF
  weights `LICENSE.txt` confirms users under both thresholds "may commercially deploy the model
  without additional authorization." **So unlike Fish, this could plausibly live in a *paid* Cast
  Pass tier** — pending the re-verify below.
- **Conditions that still apply even under the default grant:** retain the copyright notice +
  license copy (§3.4(b)); no prohibited/high-risk deployment (§4.x); **PRC governing law /
  Shanghai arbitration**; bilibili may publish **new, non-retroactive** license versions (§8).
- **Anti-distillation clause (§4.1(c))** — the model may not be used to *improve another AI
  model* (except IndexTTS-2 itself or non-commercial models). **Flag:** a synthetic-reference
  voice-cloning pipeline (fs-38) could be *argued* to brush this; generating audiobook audio does
  not, but the interplay belongs in fs-38's review, not this engine's happy path.

**Residual risk (flag, not a certification):** there is **documented ambiguity** — open issue
**#228** ("Apache 2.0 vs Commercial Use Restriction," maintainer-unanswered) and older
IndexTTS-1/1.5 artifacts reference a stricter "prior written authorization" framing that conflicts
with the threshold model. The permissive reading is correct **as currently published**, but the
license is version-sensitive. **Action: re-verify the license against the exact installed weights
version, and email `indexspeech@bilibili.com` for written confirmation, before exposing the engine
in any *paid* tier.** Personal/free use is the safe default in the meantime. Belongs in the issue's
**Depends on**.

### Sibling relationship to fs-48 (Fish S2-Pro)

fs-48 and fs-49 are **candidates for the same slot**, differentiated cleanly:

| Axis | fs-48 Fish S2-Pro | fs-49 IndexTTS-2 |
|---|---|---|
| **VRAM target** | 16GB (needs hardware we lack) | **8GB bet** (hardware we have) — *unproven* |
| **VRAM evidence** | community NF4 numbers exist | **none published** — thinner |
| **Expression model** | free-form inline tone tags | **decoupled emotion ref / 8-float vector / text** |
| **Per-line emotion fit** | re-prompt per line | **native; consumes our existing per-quote data** |
| **License** | restricted (Research License; commercial = user's problem) | **permissive by default** (≤100M MAU / RMB 1B) |
| **Paid-tier viable?** | needs legal sign-off | **plausibly yes** (pending re-verify) |
| **Quality vs Qwen** | unproven | unproven (no head-to-head benchmark exists) |

Neither is "the winner" yet — both have an unproven quality-vs-Qwen claim and an unproven VRAM
claim. fs-49's edge is **license + native per-line emotion on hardware we target**; fs-48's edge
is a **less-speculative VRAM story** (community evidence) at a higher VRAM tier. Build whichever
clears its spike first; keep the other as a documented alternative.

## The integration spine — native per-line emotion (collapses the variant-voice machinery)

This is the reason to want IndexTTS-2 specifically, and it is grounded in **verified** facts on
both sides (our code + the model's API).

**What we do today (fs-25 per-quote emotion, plan archive/177):** the analyzer tags every quote
with one of **five emotions** — `EMOTIONS = ['neutral', 'whisper', 'angry', 'excited', 'sad']`
(`server/src/handoff/schemas.ts`). To *render* a non-neutral emotion, the Qwen path **pre-designs
a separate "variant voice" per emotion per character** (`VARIANT_EMOTIONS` =
`whisper | angry | excited | sad`, `server/src/routes/qwen-voice.ts`), persisted as extra voices
under `overrideTtsVoices.qwen.variants[emotion]` and swapped in per sentence at synth time
(`src/lib/play-emotion-variant.ts`). It works, but it is **expensive** (up to four extra designed
voices per character), **pre-baked** (emotion fixed at design time), and **Qwen-only** (the code
says so explicitly).

**What IndexTTS-2 does natively:** **one** timbre (`spk_audio_prompt`) + emotion supplied
**per call** via an 8-float `emo_vector`
`[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]` with `emo_alpha` intensity.
No per-emotion voice design. The emotion is chosen at *generation* time, per sentence.

**So fs-49's spine is:** for an IndexTTS-2 cast member, **replace** the pre-baked variant-voice
mechanism with a **direct map from our per-quote `Emotion` → IndexTTS-2's `emo_vector`**, fed at
synth time inside `synthesise-chapter.ts`. This:

- **Consumes per-quote emotion data we already produce** — no new analysis, no new UX to author
  emotions; the fs-25 detection becomes the driver.
- **Eliminates the variant-voice design cost** for this engine (one timbre covers all emotions).
- **Stays on the `emo_vector` path → never loads the Qwen3-1.7B `emo_text` module** — the 8GB
  lever and the integration choice are the *same* decision.

**Scope of "replace" (decided):** replacement is **per-engine**. Qwen's existing variant machinery
(`VARIANT_EMOTIONS`, `persistEmotionVariant`, `overrideTtsVoices.qwen.variants`, the variant
designer UI, `play-emotion-variant.ts`) is **left exactly as-is**. IndexTTS-2 simply does not use
it — `pickEmotionVariantVoice` is a no-op for `index_tts2` (as it already is for Coqui/Kokoro),
and the per-sentence emotion routes into the `emo_vector` instead.

### Emotion mapping table (our 5 → IndexTTS-2's 8-float vector)

The proposed v1 map (one-hot-ish at `emo_alpha` ≈ a tuned default, refined at spike time):

| Our `Emotion` | IndexTTS-2 vector slot | Notes |
|---|---|---|
| `neutral` | `calm` (or all-zero) | the base / identity rendering |
| `angry` | `angry` | direct |
| `excited` | `happy` (consider blending `surprised`) | "excited" ≈ happy+aroused; tune at spike |
| `sad` | `sad` | direct |
| `whisper` | **no native slot — see below** | whisper is a *delivery mode*, not an emotion |

**CAVEAT to encode in the wiring code:** the 8-float **label order varies** between IndexTTS-2's
core README (`[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]`) and some
third-party wrappers (`Happy/Angry/Sad/Fear/Hate/Love/Surprise/Neutral`). **Pin the order against
the exact installed weights version** — a silent index mismatch mis-renders every line. There is
also a *separate* 7-emotion distribution used internally by the `emo_text` path
(`{Anger, Happiness, Fear, Disgust, Sadness, Surprise, Neutral}`) — **do not confuse it with the
8-float vector;** we use the 8-float vector and skip the text path.

### The `whisper` question (decided: optional emotion-ref clip)

`whisper` has no slot in the 8-float emotion vector because it is a vocal *delivery*, not an
affect. Two options, and we keep the better one as an **option** rather than mandating it:

- **Preferred (optional):** bundle a single short **"whisper" emotion-reference clip** and route
  `whisper` lines through `emo_audio_prompt` (the clip path) instead of `emo_vector`. IndexTTS-2
  supports a separate emotion clip cleanly, so this is low-cost and faithful.
- **v1 fallback if we don't bundle the clip:** map `whisper → calm` (or neutral) and **log it as a
  known gap** — the line renders un-whispered. Honest, not silent.

Decision: **ship the emotion-ref-clip path as an available option; fall back to `calm` + a logged
gap when no whisper clip is installed.** (The clip is a tiny asset, license-clean if synthetic.)

### Timbre source + bundled seed library

Like the Fish thought-bubble, IndexTTS-2 is **clone-only** for timbre — there is no fixed voice
catalog, so the timbre comes from a reference clip:

- **Primary — "design in Qwen, perform in IndexTTS-2":** Qwen-VoiceDesign invents the timbre from
  a **text persona** (our existing describe-a-voice flow), we **capture that generated clip**, and
  feed it as IndexTTS-2's `spk_audio_prompt`. No clip to record or pick. The clip is cached as the
  character's timbre.
- **Fallback — bundled seed-reference library:** a small curated set of synthetic/consented clips
  for cold-start (Qwen not installed, or an instant pick). Same age×gender taxonomy concerns as
  fs-48 (the analyzer emits `ageRange = child|teen|adult|elderly`; `neutral` gender has no
  auto-cast signal) — carried over by reference, not re-derived here.
- **Open question the spike must answer:** does a **Qwen-generated (synthetic) clip** clone *well*
  under IndexTTS-2? **No source addresses synthetic-vs-real reference behavior** — it is
  load-bearing for the whole authoring flow and is an explicit Acceptance item.

## Authoring & VRAM sequencing — the two heavy models never co-reside

Design and performance are **sequential phases**, so the Qwen-VoiceDesign model and IndexTTS-2 are
never loaded together:

1. **Design phase:** Qwen-VoiceDesign (1.7B) loaded → user describes character → timbre clip
   generated + captured → clip cached.
2. **Evict** Qwen-VoiceDesign via the existing idle watchdog (the same `QWEN_DESIGN_IDLE_TTL`
   path that already frees it).
3. **Perform phase:** load IndexTTS-2 → synth each sentence with the cached timbre clip +
   per-quote `emo_vector`.

This mirrors the VRAM discipline the Fish spec relied on, and it is why the 8GB question is about
**IndexTTS-2 alone (vector path) + headroom**, not IndexTTS-2 stacked on a design model.

## Engine architecture

### Integration shape — prefer in-process PyTorch reuse; out-of-process child is the fallback

**Preferred:** IndexTTS-2 is a pip-installable **PyTorch** project (`index-tts`) exposing a real
Python inference API (`spk_audio_prompt`, `emo_audio_prompt`, `emo_alpha`, `emo_vector`,
`use_emo_text`/`emo_text`, plus the two duration modes). So it slots in as a **normal in-process
engine** in the sidecar `ENGINES` map exactly like Coqui/Qwen: loads with our device-selection
(`cuda` → `mps`/`cpu`), and `synthesize()` is a direct model call returning `SynthResult`
(int16-LE PCM + sample rate). No new process, no IPC.

**Fallback (only if the in-process path proves brittle):** run IndexTTS-2 as a **child process**
behind an HTTP shim and adapt the result into `SynthResult` — heavier (lifecycle, health, port,
`taskkill /T /F` teardown for Windows parity), documented so it is not a surprise. **The 8GB spike
decides which:** if VRAM is tight, in-process reuse (one CUDA context, no duplicate torch) is
strictly better for the budget.

Either way a thin `IndexTts2Engine` registers in `ENGINES` under id **`index_tts2`** (short key
**`index`**) to satisfy routing; only its internals differ. The base `Engine` declares only
`synthesize(...)`; `unload()` / `_ensure_loaded()` / idle-evict are per-engine conventions Fish/
Qwen/Coqui follow and IndexTTS-2 follows too.

### Lifecycle

- **Opt-in, on-demand load** (`PRELOAD_INDEXTTS=0`); loading **evicts the analyzer Ollama** via
  the existing load-time eviction (the real OOM guard, not the semaphore), and vice-versa.
- **Idle-evict modelled on ASR/Whisper, not Qwen-VoiceDesign** — IndexTTS-2 is the *resident*
  synth engine while in use, so its idle watchdog frees the **whole engine** (and tears down the
  child process in the out-of-process fallback), mirroring `WhisperEngine.maybe_free_idle`.
- **VRAM accounting is advisory, not a safety net.** The weighted semaphore arbitrates unitless
  tokens, not GB (`engine-vram-cost.ts`, "PROVISIONAL VALUES … not measured"); it cannot prevent
  OOM. IndexTTS-2 must register a **`gpu.weight.index` knob in `registry.ts`** (with a
  `GPU_WEIGHT_INDEX` env, like `gpu.weight.qwen`) **and** update the budget help-text that
  hard-lists the per-engine weights. A measured weight comes out of the spike; until then it is a
  guess. OOM-prevention rests on **load-time eviction + sequential design/perform phases**, not the
  token count. (fs-45 VRAM telemetry records but does not yet drive eviction.)

### Install

- New `scripts/install-indextts2.{ps1,sh}` fetching the weights with `hf download
  IndexTeam/IndexTTS-2 --local-dir server/tts-sidecar/voices/index/` (not `git lfs clone`).
- Python deps pinned in `requirements/nvidia-cuda.txt`: the `index-tts` package + its torch /
  flow-matching / BigVGAN deps. AMD/CPU left to a follow-on.
- **The bundled "whisper" emotion-ref clip** (optional path) ships under `voices/index/` as a
  tiny asset.
- **Not** in the release zip (weight size + the same user-fetch posture as Kokoro/Coqui).
- The install script must **verify the weights load** and **print the license summary** (§Gate 2)
  at install time so the obligations surface at the point of opt-in.

## The 8GB bet (the core engineering question)

16GB is *not* the target here — **8GB is** — and that is exactly what is unproven. Levers the
spike should pull, strongest first:

1. **Vector-path emotion, `emo_text` module never loaded.** Driving emotion from the 8-float
   vector (fed by our analyzer) means the **Qwen3-1.7B** T2E sub-model is never instantiated. This
   is the single biggest saving and is a *free* consequence of the integration spine.
2. **Evict the analyzer Ollama during synth** (existing behavior) — reclaims its footprint.
3. **Sequential stage-loading / vocoder CPU-offload** (build-it-yourself; no IndexTTS-2 precedent)
   — only if (1)+(2) don't clear the budget.
4. **DIY quantization** (int8/int4) — **no public patch exists**, so this is real work, reserved
   for last; flag the quality risk (4-bit most threatens the very expressiveness that is the
   selling point — the same caution fs-48 raised for NF4).

**Two unknowns the spike must resolve beyond "does it fit":**

- **Peak under a long KV cache.** The autoregressive T2S stage grows a KV cache over a long
  sentence; whatever the idle footprint, the *peak* under chapter-length lines including OS
  headroom (~1–2GB on Windows idle) is what matters. If the raw path overflows, chunked synthesis
  is the expected rescue.
- **RTF for chapter-length audio.** Undisclosed everywhere. The bar is "usable for a whole
  chapter," not "a demo sentence renders."

If no lever holds 8GB at acceptable speed/quality, the item **falls to a 16GB-class Could** beside
Fish (§Fallback), and the headline "on hardware you already own" is lost.

### Fallback ladder (honest about what each rung saves)

1. Vector-path + Ollama-evict + chunking holds 8GB → **the Should case.**
2. Needs 12–16GB → ship as a 16GB-class **Could**, beside Fish; the "8GB" headline is gone —
   trigger a *should-we-even-ship-two-16GB-engines* re-evaluation, since Fish then has the better
   VRAM evidence.
3. The **emotion-decoupling quality gate** (Acceptance #3, issue #433) *or* the
   **better-than-Qwen gate** (Acceptance #2) fails at every precision → **the item parks** — an
   engine no better than the resident Qwen isn't worth its VRAM.

## Integration seams (indicative — plan-time detail)

_File/function names verified against today's `main` to size the work; not a frozen contract.
The genuinely **load-bearing** dependency for go/no-go is **srv-43** (per-character `voiceUuid`);
the rest is plan-time content captured early. fs-49 deliberately mirrors fs-48's seam list so the
two are easy to compare._

**Sidecar (Python):**
- `server/tts-sidecar/main.py` — `IndexTts2Engine` registered in `ENGINES`; **preferred:**
  in-process torch loader; **fallback:** HTTP-child adapter. ASR-style whole-engine idle-evict.
  Maps our `Emotion` → `emo_vector`; routes `whisper` → `emo_audio_prompt` (whisper clip) when
  present.
- `server/tts-sidecar/requirements/nvidia-cuda.txt` — `index-tts` + deps + pins.
- `server/tts-sidecar/scripts/install-indextts2.{ps1,sh}` — `hf download` weights + license print.
- `voices/index/` — cached per-character timbre clips + the optional whisper emotion-ref clip +
  any bundled seed library.
- New `server/tts-sidecar/tests/test_indextts2.py`.

**Server (Node/TypeScript):**
- `server/src/tts/model-keys.ts` — add `index_tts2` to `TtsEngine`; an `index-tts2` `TtsModelKey`;
  a label; arm `isTtsModelKey()`, `engineForModelKey()`, `canonicalModelKeyForEngine()`,
  `sidecarModelId()`. *(These four exist and are correctly named — verified.)*
- `server/src/tts/voice-mapping.ts` — IndexTTS-2's clone-only handling + a `indexStorageKey`
  mirroring `qwenStorageKey` (**depends on srv-43 `voiceUuid`**); `pickEmotionVariantVoice` stays a
  no-op for `index_tts2`; extend the private `catalogForEngine` / `describeVoice` / `auditEngineCatalog`
  switch bodies for the seed-library catalog.
- `server/src/tts/synthesise-chapter.ts` — per-character routing on `index_tts2`; **the per-quote
  `Emotion` → `emo_vector` map lives here** (the spine); generalise `applyQwenFallback`'s hardcoded
  `=== 'qwen'` guard (see Fallback below); **do not** copy Qwen's `synthesize_batch` path
  (per-call, like Coqui).
- `server/src/analyzer/fill-tone.ts` — _not modified_; noted only because the **character `tone`**
  (warmth/pace/authority/emotion, 0–100) is a *separate*, per-character signal from the per-quote
  `Emotion`. v1 drives emotion from the per-quote `Emotion` only; whether to *also* bias the
  `emo_vector`/`emo_alpha` from the character `tone.emotion` axis is a plan-time refinement, not v1.
- `server/src/tts/engine-health.ts` — add `'index'` to the `EngineId` union; **leave out of the
  `STANDARD` set** so `engineTier ⇒ secondary`.
- `server/src/routes/sidecar-health.ts` + `routes/models-inventory.ts` — per-engine install/health
  state (`not-installed | weights-missing | ready | loaded`), mirroring `qwen_install_state`.
- `server/src/config/registry.ts` — `gpu.weight.index` knob (+ `GPU_WEIGHT_INDEX`), budget
  help-text update, idle TTL.
- The voice-design route — accept the "capture Qwen clip → IndexTTS-2 timbre" flow; mint the
  IndexTTS-2 `voiceUuid`.

**Frontend (React/TypeScript):**
- `src/views/cast.tsx` — engine picker exposes IndexTTS-2 when installed.
- `src/components/ModelControlPill.tsx` — IndexTTS-2 health card + Load / Stop / Repair (the real
  Model-Manager component).
- The model inventory surfacing — `models-inventory` route read into **local component state**
  (`model-manager.tsx` / `ModelControlPill.tsx`); **not** Redux (there is no models slice).
- Voice-picker UI — the seed-library picker + the describe-in-Qwen authoring entry; **no
  per-emotion variant designer for this engine** (native emotion replaces it).

**Docs:** a regression plan under `docs/features/`; `INDEX.md` entry; INSTALL/README engine list +
the license/attribution notice.

### Fallback + multilingual (a known gap, not a solved fallback)

`applyQwenFallback` is **hardcoded to `route.engine === 'qwen'`** and falls back **only to
English-only Kokoro**, throwing `MissingDesignedVoiceError` when `forbidKokoroFallback` (non-English
books). So (a) the guard must be **generalised** to fire for IndexTTS-2, and (b) **multilingual
coverage is unverified** — the research found *no* confirmation of languages beyond English/Chinese
(benchmarks were en/zh only), and **Russian support is an open question** (load-bearing for our RU
books). Until confirmed, an undesigned non-English IndexTTS-2 character has **no graceful fallback**
— a hard error, same honest posture as fs-48. **Russian coverage is an explicit Acceptance item.**

## Acceptance criteria (the spike's pass/fail bar)

1. A cast member can be assigned an IndexTTS-2 voice (timbre captured from a Qwen-designed clip, or
   a bundled seed clip), and a chapter generates end-to-end with **per-sentence emotion driven from
   our existing per-quote `Emotion` via `emo_vector`** — no per-emotion variant voices designed.
2. **8GB primary bet (hardware-gated spike, the promotion trigger):** on a real 8GB consumer card,
   the **vector-path** build (Qwen3-1.7B `emo_text` module **not** loaded) generates a full chapter
   with **peak VRAM ≤ 8GB** *including OS headroom* and *under a long sentence's KV cache* (chunked
   if needed), with the analyzer Ollama evicted, at **RTF ≥ a threshold set at spike time** —
   usable for chapter-length audio. **Pass ⇒ the item becomes a Should.**
3. **Emotion-decoupling quality (make-or-break, issue #433):** a subjective A/B confirms the
   *shipped weights* actually deliver timbre-stable, recognisable per-line emotion (the paper's GRL
   decoupling may not be fully realised in the released checkpoint). If emotion bleeds the timbre or
   the affects are indistinct, the headline fails.
4. **Quality vs the resident engine:** IndexTTS-2 is **audibly at least as good as Qwen** on the
   same lines (no public benchmark compares them — this A/B is the only evidence). An engine no
   better than the resident one isn't worth the VRAM.
5. **Synthetic-clip clone fidelity:** a **Qwen-generated** timbre clip clones acceptably under
   IndexTTS-2 (unaddressed by every source — the whole "design in Qwen" flow rests on it).
6. **Russian / multilingual:** confirm whether IndexTTS-2 renders acceptable Russian (and any other
   target language); if English/Chinese-only, scope the engine to those and state it.
7. License/attribution surfaced: enabling the engine shows the (permissive-by-default, re-verify-
   before-paid-tier) license summary and retains the required notice.

## Testing approach

- **Sidecar pytest** — `test_indextts2.py` mirroring `test_kokoro.py`: load / synthesize / unload
  (in-process path — or process spawn/teardown for the fallback), returns PCM + sample-rate header,
  idle-evict frees the whole engine, the **`Emotion` → `emo_vector` map** produces audibly distinct
  output per emotion, whisper routes to the clip path when present. **Triple-gated SKIP** (venv /
  pytest / weights absent), like the golden tiers.
- **Server vitest** — `model-keys` and `voice-mapping` arms; the `Emotion → emo_vector` mapping
  table (incl. the label-order pin and the `whisper → calm` fallback); the **generalised fallback**
  (IndexTTS-2 English → Kokoro; non-English → `MissingDesignedVoiceError`); `pickEmotionVariantVoice`
  no-op for `index_tts2`.
- **Frontend vitest** — engine appears in the picker **only when installed**; **no** variant-emotion
  designer renders for an IndexTTS-2 character; any drawer-nested overlay `createPortal`s to
  `document.body` (the clip-path regression guard from PR #832).
- **Golden-audio** — add an IndexTTS-2 line to the opt-in golden tier once stable (deferred).

## Risks & dependencies

1. **8GB unproven + un-deskable + hardware-gated** *(Gate 1 / the make-or-break)* — no published
   params/VRAM/RTF; no community quant; a four-stage stack. The whole "Should" hinges on the spike.
2. **Emotion-decoupling may not be realised in the shipped weights** *(issue #433, single-sourced)*
   — the paper's GRL training may be absent from the release; A/B it, don't assume it.
3. **Quality vs Qwen is unproven** — benchmarks are author-self-reported (IndexTTS-2 even "beats"
   human ground truth — a benchmark-optimism red flag) and **exclude Qwen, Fish, and XTTS**.
4. **Synthetic-reference behavior unknown** — no source covers cloning from a TTS-generated clip;
   the authoring flow depends on it.
5. **Multilingual / Russian unverified** — benchmarks en/zh only; non-English fallback is a hard
   error until confirmed.
6. **License version-sensitivity** *(Gate 2)* — permissive as published, but custom/source-available
   with an unresolved #228, an anti-distillation clause that could touch fs-38 cloning, and PRC law;
   re-verify + email confirmation before any paid-tier exposure.
7. **srv-43 dependency** — IndexTTS-2's per-character storage key needs the `voiceUuid` apparatus
   (mirrors Fish). Blocks the clone-only timbre persistence.
8. **VRAM weight is a guess** until the spike measures it; the semaphore is advisory, not an OOM guard.
9. **Label-order / API drift** — the 8-float vector order and inference param names vary across
   versions/wrappers; pin against the installed weights or every line mis-renders.

## Out of scope

- AMD/ROCm and CPU support (NVIDIA-CUDA first).
- IndexTTS-2's natural-language `emo_text` path (loads the Qwen3-1.7B module) — deliberately unused
  in v1; a "max-expressiveness, needs-more-VRAM" mode is a *possible* follow-on once 8GB is proven.
- Biasing `emo_vector`/`emo_alpha` from the per-character `tone` axes — a plan-time refinement.
- IndexTTS-2 as the engine behind user voice-cloning (fs-38) — a natural follow-on, but note the
  anti-distillation clause interplay (§Gate 2).
- Inclusion in the release zip (weights are user-fetched).
- Promoting the seed-library age×gender taxonomy to a cross-engine `VoiceProfile` concept.

## Backlog framing

- **MoSCoW: Could now — auto-promotes to Should iff the 8GB spike (Acceptance #2) passes.** A plain
  "Should" would over-state readiness (the 8GB thesis is an unverified bet on a thinner evidence
  base than Fish); a plain "Could" understates it (if the spike lands it's a real upgrade on
  hardware users own, plus a permissive license Fish lacks). So it is filed as a **Could** tagged
  **"8GB-spike promotes to Should; depends on srv-43 + license re-verify"** in `docs/BACKLOG.md`.
  Prefix `fs-`. **Next free id confirmed = `fs-49`** (fs-48 is the Fish sibling).
- Issue carries What / Acceptance / **Key files** / **Depends on (srv-43 + an 8GB hardware spike +
  a license re-verify before paid-tier)** / Benefit; a thin row lands in `docs/BACKLOG.md` under
  **Could**, linking this spec and the Fish sibling.
- **Benefit (user):** finer, **per-line emotional performance** from a single designed voice — the
  thing our pre-baked variant-voice flow does expensively and Qwen-only — driven by the emotion data
  we already detect, **potentially on the 8GB card the user already owns** and under a license
  permissive enough for a paid tier. The headline upside over Fish is **native per-line emotion +
  license + target hardware**; the headline risk is **the unproven 8GB fit**.
