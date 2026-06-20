# fs-49 — IndexTTS-2 expressive TTS engine (decoupled per-line emotion)

- **Date:** 2026-06-20
- **Issue:** _to be filed_ (`area:fs`, `moscow:could` — _a passing 8GB spike makes it **eligible
  for re-triage** to `should`, not an automatic promotion; see §Backlog framing_, `type:feat`)
- **Branch:** _none yet — backlog item; spec only, no plan this round_
- **Status:** design hardened over **one adversarial review round** (three parallel critics:
  feasibility, consistency/spine, license/product). A **sibling** to the parked Fish S2-Pro spec
  ([2026-06-20-fish-audio-s2pro-engine-design.md](2026-06-20-fish-audio-s2pro-engine-design.md));
  the two compete for the same "expressive perform engine" slot.
- **Revision note:** **v2** folds in the first adversarial round. The reviews were unanimous on
  one asymmetry: the spec was honest about the *technical* unknowns but **systematically
  optimistic on the legal axis**. v2 fixes (a) the "1.7B is the largest VRAM lever" false
  comfort — the three *always-resident* stages of unknown size decide the fit; (b) the license
  headline — it is a **source-available, threshold-gated custom bilibili license, NOT
  Apache/MIT**, and that qualifier now rides in the Summary/table/Benefit; (c) integration mode
  is now a **spike output**, not a pre-declared preference; (d) RTF + the full four-stage VRAM
  budget (flow-matching NFE, AR sequential decode, BigVGAN activation memory, cold-load) are
  scoped; (e) anti-distillation §4.1(c) is analyzed across fs-49's *own* surfaces; (f) several
  decide-it-now items resolved (`neutral → all-zero`, `emo_alpha` v1, whisper-clip ships).
- **Provenance note:** every IndexTTS-2 fact traces to a verified, adversarially-checked research
  pass (arXiv 2506.21619 v1/v2; the `index-tts/index-tts` repo + LICENSE; the `IndexTeam/IndexTTS-2`
  HuggingFace weights card; project page). Claims the research could **not** settle — chiefly the
  8GB fit, RTF, and quality-vs-Qwen — are marked **unverified / spike-gated**, not asserted.
  Codebase seam names were checked against today's `main`; where a name is indicative it says so.
  Where the text cites **upstream `index-tts` issue #NNN**, that is a bilibili-repo issue, *not* a
  Castwright issue (ours is "to be filed").

## Summary

Add **IndexTTS-2** (IndexTeam / bilibili; arXiv 2506.21619, mid-2025) as an **opt-in** synthesis
engine alongside Kokoro, Coqui XTTS, and Qwen. Its headline is the one capability our pipeline
most wants and does not have cheaply today: **decoupled, per-line emotional expression** — **one**
timbre, with emotion driven **at inference time, per sentence**, from data we already compute. Qwen
stays the default engine; IndexTTS-2 is the engine a user switches to when they want to *try* finer
per-line expression.

What the research **verified** (the evidenced lead):

1. **Decoupled per-line emotion is real *in the paper's design*.** IndexTTS-2 separates speaker
   timbre (`spk_audio_prompt`) from emotion (`emo_audio_prompt` / `emo_vector` / `emo_text`) — a
   Gradient Reversal Layer is *described* as making the emotion embedding invariant to timbre, and
   the emotion prompt may even come from a *different* speaker. **Caveat carried from the research:**
   whether the *released checkpoint* actually realises that decoupling is **unconfirmed** (upstream
   `index-tts` issue #433, single-sourced) — so this is "architecturally motivated, A/B-gated"
   (Acceptance #3), not "proven in the weights we'd ship."
2. **The license is a source-available, threshold-gated commercial grant** — a **custom "bilibili
   Model Use License Agreement," NOT Apache/MIT, NOT CC-BY-NC**. Commercial use is permitted *by
   default below a large scale threshold*, which is **lighter than Fish's Research License** — but
   it carries real conditions (anti-distillation, PRC governing law, notice-retention) and a live,
   maintainer-unanswered ambiguity (#228). It is **not** "permissive" in the Apache/MIT sense, and
   any paid-tier exposure needs written confirmation first (Gate 2).

What the research **could not verify** — the thing that would make this a must-build: **does it fit
a consumer 8GB GPU, and is it actually better than Qwen.** No primary source discloses parameter
count, inference VRAM, quantization footprint, or RTF; **no community quantization patch exists**;
and every quality benchmark is author-self-reported and **excludes Qwen/Fish/XTTS**. So the
**8GB-Qwen-beater thesis is an honest bet, not a fact** — it rides entirely on a hardware + A/B
spike (Gate 1). If the bet lands, this is a genuine upgrade *if it fits* the 8GB hardware our users
already own. If it doesn't, it falls back to a 16GB-class **Could** beside Fish.

**The design choice that gives the bet a chance is the same one that makes the integration clean:**
drive emotion from the **8-float `emo_vector`** path (fed by our existing per-quote emotion analysis)
rather than IndexTTS-2's natural-language `emo_text` path — because `emo_text` instantiates a
**Qwen3-1.7B** sub-model and the vector path does not. **Important honesty (v2):** this removes one
*optional* model from the *worst case*; it is **not** "the model mostly fits because we skip 1.7B."
The three **always-resident** stages — the T2S autoregressive transformer, the S2M flow-matching
module, and the BigVGANv2 vocoder — have **no published parameter count**, and *their* combined
footprint is what actually decides 8GB. The 1.7B skip is a worst-case ceiling cut, not the
load-bearing saving (§"The 8GB bet").

## Why this is a Could-that-can-become-a-Should, and the gates

Stated up front so a future implementer inherits the framing.

### Gate 1 — 8GB feasibility + quality (the re-triage trigger AND the make-or-break)

This is the load-bearing unknown, **hardware-gated** (needs a physical 8GB card on our pipeline) and
**currently un-deskable** — no further reading resolves it, because the numbers were never published:

- **No total/per-module parameter count** anywhere. Only architectural dims (T2S `model_dim` 1280 /
  24 layers / 20 heads; S2M `hidden_dim` 512 / depth 13) — not parameter counts. A 1280-wide /
  24-layer transformer is plausibly 1–2B on its own; flow-matching + BigVGAN add more. **We do not
  know which of the four stages dominates the budget.**
- **No measured inference VRAM, no quantization data, no RTF.** The only hardware figure anywhere is
  *training* (8× A100 80GB) — not inference.
- **The "8GB" figure that circulates online is for IndexTTS *1.5*, a different model** — do **not**
  assume it transfers to v2.
- **No community GGUF / int4 / FP8 patch** was found — so any sub-budget quant is a build cost we
  bear, not a download. On the VRAM-evidence axis IndexTTS-2 is **thinner than Fish** (which had a
  community NF4 ecosystem to point at). **fs-49 is the *more* speculative build of the two siblings.**

**The spike's job** (Acceptance #2–#5): measure peak VRAM (vector-path, 1.7B module *not* loaded)
**across all four resident stages** and RTF for *chapter-length* generation on a real 8GB card, with
the analyzer Ollama evicted (the real 8GB constraint — they evict each other today) — **and** A/B
the output against Qwen and against full precision. **Pass on all of VRAM + RTF + quality ⇒ the item
becomes *eligible for re-triage* to Should** (not an automatic bump — see §Backlog framing).

### Gate 2 — License (threshold-gated commercial grant; lighter than Fish, but NOT permissive-in-the-Apache-sense)

The weights ship under a **custom source-available "bilibili Model Use License Agreement"** (bilibili
is the right-holder; IndexTeam is its internal dev team) — **not** Apache/MIT, **not** CC-BY-NC. The
code is Apache-2.0; the **weights** carry the bilibili license. Verified facts:

- **Commercial use — including audiobooks for sale — is permitted by default *below a scale
  threshold*.** §2.1 grants a "worldwide, non-exclusive, non-transferable, royalty-free limited
  license to Use"; the **only** scale restriction (§2.2) triggers a separate negotiated license
  **above >100M MAU or >RMB 1B annual revenue** — orders of magnitude beyond Castwright. The HF
  weights `LICENSE.txt` confirms users under both thresholds "may commercially deploy the model
  without additional authorization."
- **This is lighter than Fish — but it is a *grant with conditions*, not "permissive."** Conditions
  that apply even under the default grant:
  - **Notice retention (§3.4(b))** — retain the copyright notice **and a copy of the license**. This
    is a redistribution obligation (ship the license file), not satisfied by an install-time summary
    print — see §Install / Acceptance #7 for the concrete commitment.
  - **No prohibited/high-risk deployment (§4.x).**
  - **Anti-distillation (§4.1(c))** — the model may not be used to *improve another AI model* (except
    IndexTTS-2 itself or non-commercial models). **This touches three fs-49 surfaces — analyzed in
    §Anti-distillation exposure below, not deflected to fs-38.**
  - **PRC governing law / Shanghai arbitration.** **Practical consequence, stated plainly:** for a
    solo Western operator, a dispute resolved by Shanghai arbitration under PRC law is **effectively
    non-defensible and non-enforceable** — prohibitively expensive and foreign-jurisdiction. The
    correct risk posture is therefore **"comply with the strictest plausible reading,"** not "rely on
    winning the argument."
  - **Version non-retroactivity (§8).** bilibili may publish new license versions; they are
    non-retroactive. **Product consequence (§License version pinning below).**

**Residual risk (flag, not a certification):** there is **documented ambiguity** — upstream
`index-tts` issue **#228** ("Apache 2.0 vs Commercial Use Restriction," maintainer-unanswered) and
older IndexTTS-1/1.5 artifacts reference a stricter "prior written authorization" framing that
conflicts with the threshold model (an inquirer emailed `indexspeech@bilibili.com` and got no reply).
The threshold reading is correct **as currently published**, but it is **a reasonable reading of
disputed source-available terms, not a verified fact.**

**Decided posture:** **personal / free use is the safe default.** Exposing the engine in *any paid
tier* requires a **license re-verify against the exact installed weights version + written
confirmation from bilibili** first. (The spec does **not** name a specific revenue product as
"cleared" — see §Backlog framing.)

#### Anti-distillation exposure (§4.1(c)) — three fs-49 surfaces

§4.1(c) forbids using the model to improve *another AI model* (except IndexTTS-2 or non-commercial
models). It is **not** only an fs-38 concern; it touches fs-49's own design:

1. **The primary authoring flow** ("design in Qwen → capture clip → clone under IndexTTS-2") feeds a
   *generated* clip into IndexTTS-2 to mint a reusable timbre. Whether minting a reusable voice asset
   from model output counts as "improving a model" is a plausible-reading question — **re-verify item.**
2. **fs-38 user voice-cloning**, if IndexTTS-2 ever backs it — a *commercial* cloning feature is
   closest to the prohibited category — **re-verify item, deferred to fs-38 but flagged here.**
3. **The DIY-quantization lever** (§"The 8GB bet" lever 4): quantizing/distilling the weights for a
   derivative could implicate the anti-distillation / modification terms — **re-verify item.**

None of these is a happy-path blocker for *personal* audiobook generation; all three are re-verify
items before any *commercial/paid* exposure.

#### License version pinning (the product-load-bearing consequence of §8)

Because the grant is version-non-retroactive and the output is *sold*: the install script must
**record the exact license version + weights hash installed**. Document that **already-generated
audio falls under the license version accepted at generation time**; **re-generating** after a §8
update requires re-accepting the then-current terms. Surface a **re-verify checkpoint on any weights
update.** This makes non-retroactivity actually protective instead of decorative.

### Sibling relationship to fs-48 (Fish S2-Pro)

fs-48 and fs-49 are **candidates for the same slot**. The table is a *comparison of unknowns*, not a
scorecard — read the honesty note below it before treating any cell as an advantage:

| Axis | fs-48 Fish S2-Pro | fs-49 IndexTTS-2 |
|---|---|---|
| **VRAM target** | 16GB (needs hardware we lack) | **targets 8GB — fit unproven** |
| **VRAM evidence** | community NF4 numbers exist | **none published — thinner; fs-49 is the *more* speculative build** |
| **Expression model** | free-form inline tone tags | decoupled emotion ref / 8-float vector / text |
| **Per-line emotion fit** | re-prompt per line | **native; consumes our existing per-quote data** |
| **License** | restricted Research License (commercial = user's problem) | source-available threshold-gated grant — *lighter, but unverified (#228) & conditions apply* |
| **Paid-tier viable?** | needs legal sign-off | **also needs legal sign-off** (more permissive *if* the threshold reading holds) |
| **Quality vs Qwen** | unproven | unproven (benchmarks self-reported, **Qwen-excluded**) |

> **Honesty note (don't let the table tilt the build decision).** *Both* engines need legal sign-off
> before a paid tier; fs-49's license is more permissive **only if** the threshold reading survives
> re-verify (#228 is open). And on the **one axis with more evidence — VRAM — Fish is the *less*
> speculative bet**, because community NF4 numbers exist and IndexTTS-2's footprint is wholly
> unpublished. fs-49's genuine, evidenced edge is the **mechanism** (native per-line emotion from data
> we already compute), not a settled license or quality win. Build whichever clears its spike first;
> keep the other as a documented alternative.

## The integration spine — native per-line emotion (collapses the variant-voice machinery)

This is the reason to want IndexTTS-2 specifically, and it is grounded in **verified** facts on both
sides (our code + the model's API).

**What we do today (fs-25 per-quote emotion, plan archive/177):** the analyzer tags every quote with
one of **five emotions** — `EMOTIONS = ['neutral', 'whisper', 'angry', 'excited', 'sad']`
(`server/src/handoff/schemas.ts`). To *render* a non-neutral emotion, the Qwen path **pre-designs a
separate "variant voice" per emotion per character** (`VARIANT_EMOTIONS` =
`whisper | angry | excited | sad`, `server/src/routes/qwen-voice.ts`), persisted as extra voices under
`overrideTtsVoices.qwen.variants[emotion]` and swapped in per sentence at synth time
(`src/lib/play-emotion-variant.ts`). It works, but it is **expensive** (up to four extra designed
voices per character), **pre-baked** (emotion fixed at design time), and **Qwen-only**.

**What IndexTTS-2 does natively:** **one** timbre (`spk_audio_prompt`) + emotion supplied **per call**
via an 8-float `emo_vector` `[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]`
with `emo_alpha` intensity. No per-emotion voice design. Emotion is chosen at *generation* time, per
sentence.

**So fs-49's spine is:** for an IndexTTS-2 cast member, **replace** the pre-baked variant-voice
mechanism with a **direct map from our per-quote `Emotion` → IndexTTS-2's `emo_vector`**, fed at synth
time inside `synthesise-chapter.ts`. This:

- **Consumes per-quote emotion data we already produce** — no new analysis, no new authoring UX.
- **Eliminates the variant-voice design cost** for this engine (one timbre covers all emotions).
- **Stays on the `emo_vector` path → never instantiates the Qwen3-1.7B `emo_text` module** — the
  integration choice and the worst-case VRAM ceiling cut are the *same* decision.

**Scope of "replace" (decided):** replacement is **per-engine**. Qwen's existing variant machinery
(`VARIANT_EMOTIONS`, `persistEmotionVariant`, `overrideTtsVoices.qwen.variants`, the variant designer
UI, `play-emotion-variant.ts`) is **left exactly as-is**. IndexTTS-2 simply does not use it —
`pickEmotionVariantVoice` is a no-op for `index_tts2` (as it already is for Coqui/Kokoro), and the
per-sentence emotion routes into the `emo_vector` instead.

### Emotion mapping table (our 5 → IndexTTS-2's 8-float vector)

v1 map. **`emo_alpha` v1 default = 1.0** (one-hot, full intensity); the spike tunes it downward if
1.0 over-acts.

| Our `Emotion` | IndexTTS-2 vector | Notes |
|---|---|---|
| `neutral` | **all-zero vector** (decided) | the base / identity rendering. **Not `calm`** — `calm` is itself an affect that would flatten an already-neutral line; all-zero = "no emotion signal," the truer identity. |
| `angry` | `angry` = `emo_alpha` | direct |
| `excited` | `happy` = `emo_alpha` (spike may blend in `surprised`) | "excited" ≈ happy+aroused; tune at spike |
| `sad` | `sad` = `emo_alpha` | direct |
| `whisper` | **emotion-ref clip path, not the vector** | a delivery mode, not an affect — see below |

**The four unused slots** (`afraid`, `disgusted`, `melancholic`, `surprised`) are **intentionally
unused** because our analyzer emits no corresponding emotion. If fs-25's emotion set ever expands,
they are the natural extension points.

**CAVEAT to encode in the wiring code:** the 8-float **label order varies** between IndexTTS-2's core
README (`[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]`) and some third-party
wrappers (`Happy/Angry/Sad/Fear/Hate/Love/Surprise/Neutral`). **Pin the order against the exact
installed weights version** — a silent index mismatch mis-renders every line. There is also a
*separate* 7-emotion distribution used internally by the `emo_text` path
(`{Anger, Happiness, Fear, Disgust, Sadness, Surprise, Neutral}`) — **do not confuse it with the
8-float vector;** we use the 8-float vector and skip the text path.

### The `whisper` question (decided: ships an emotion-ref clip; `calm`-fallback only if the asset is absent)

`whisper` has no slot in the 8-float emotion vector because it is a vocal *delivery*, not an affect.
**Decision (v2, made consistent):** fs-49 **bundles a single short "whisper" emotion-reference clip by
default** (a tiny, license-clean synthetic asset under `voices/index/`) and routes `whisper` lines
through `emo_audio_prompt` (the clip path). The `whisper → all-zero/neutral` branch fires **only** if
that asset is missing/deleted, and it **logs the gap** (the line renders un-whispered) rather than
failing silently. Both branches are gated: see Acceptance #1a and the test plan.

### Timbre source + bundled seed library

IndexTTS-2 is **clone-only** for timbre — no fixed catalog, so timbre comes from a reference clip:

- **Primary — "design in Qwen, perform in IndexTTS-2":** Qwen-VoiceDesign invents the timbre from a
  **text persona** (our existing describe-a-voice flow), we **capture that generated clip**, and feed
  it as IndexTTS-2's `spk_audio_prompt`. No clip to record or pick. The clip is cached as the
  character's timbre. *(See §Anti-distillation exposure for the §4.1(c) re-verify on this flow.)*
- **Fallback — bundled seed-reference library:** a small curated set of synthetic/consented clips for
  cold-start. Same age×gender taxonomy concerns as fs-48 (analyzer emits `ageRange =
  child|teen|adult|elderly`; `neutral` gender has no auto-cast signal) — carried by reference.
- **Open question the spike must answer (Acceptance #5):** does a **Qwen-generated (synthetic) clip**
  clone *well* under IndexTTS-2? **No source addresses synthetic-vs-real reference behavior** — it is
  load-bearing for the whole authoring flow.

## Authoring & VRAM sequencing — the two heavy models never co-reside

Design and performance are **sequential phases**, so Qwen-VoiceDesign and IndexTTS-2 are never loaded
together:

1. **Design phase:** Qwen-VoiceDesign (1.7B) loaded → user describes character → timbre clip generated
   + captured → cached.
2. **Evict** Qwen-VoiceDesign via the existing idle watchdog (`QWEN_DESIGN_IDLE_TTL`).
3. **Perform phase:** load IndexTTS-2 → synth each sentence with the cached timbre clip + per-quote
   `emo_vector`.

So the 8GB question is about **IndexTTS-2 alone (vector path) + OS headroom**, not IndexTTS-2 stacked
on a design model.

## Engine architecture

### Integration shape — a SPIKE OUTPUT, not a pre-declared preference (v2)

IndexTTS-2 is a pip-installable **PyTorch** project (`index-tts`) exposing a real Python inference API
(`spk_audio_prompt`, `emo_audio_prompt`, `emo_alpha`, `emo_vector`, `use_emo_text`/`emo_text`, plus
two duration modes). In principle it slots in as a normal in-process engine in the sidecar `ENGINES`
map like Coqui/Qwen, returning `SynthResult` (int16-LE PCM + rate) from a direct call.

**But the spike must DECIDE in-process vs out-of-process — it is not pre-settled in in-process's
favour** (v2 reversal). Two unknowns the project's own history says to respect:

- **Dependency collision.** A four-stage mid-2025 research repo is a prime candidate to pin torch /
  CUDA / BigVGAN / flow-matching versions that **conflict with the versions Coqui/Qwen/Whisper already
  pin** in the shared sidecar venv. Our memory is full of exactly these scars (Coqui dropping torch;
  the `kokoro-onnx[gpu]` onnxruntime collision). If the pins collide, **out-of-process is the
  default**, not the fallback.
- **Clean teardown on an 8GB budget.** In-process means IndexTTS-2's CUDA context, allocator
  fragmentation, and anything it fails to free on `unload()` live inside the long-running sidecar —
  precisely where a leaked/fragmented allocation poisons the *next* engine on a tight budget (cf. the
  fs-45 sticky-high-water bug). If `unload()` doesn't return VRAM cleanly, out-of-process isolation
  wins.

**Spike deliverable:** "do `index-tts`'s pins co-exist with the existing venv, and does `unload()`
return VRAM cleanly on 8GB? If either fails, out-of-process child (HTTP shim, `taskkill /T /F`
teardown for Windows parity) is the **default**." Either way a thin `IndexTts2Engine` registers in
`ENGINES` under id **`index_tts2`** (short key **`index`**); only its internals differ.

### Lifecycle

- **Opt-in, on-demand load** (`PRELOAD_INDEXTTS=0`); loading **evicts the analyzer Ollama** via the
  existing load-time eviction (the real OOM guard, not the semaphore), and vice-versa.
- **Idle-evict modelled on ASR/Whisper, not Qwen-VoiceDesign** — IndexTTS-2 is the *resident* synth
  engine while in use, so its idle watchdog frees the **whole engine** (and tears down the child
  process in the out-of-process mode), mirroring `WhisperEngine.maybe_free_idle`.
- **Cold-load time is a real cost** (v2): a four-stage stack that *evicts the analyzer Ollama to load*
  can have a multi-second-plus cold start. It MUST show a user-visible loading state and is an
  acceptance item (#2a) — silent multi-second loads read as "did it hang?" (we have prior support
  pain here).
- **VRAM accounting is advisory, not a safety net.** The weighted semaphore arbitrates unitless
  tokens, not GB (`engine-vram-cost.ts`, "PROVISIONAL VALUES … not measured"); it cannot prevent OOM.
  IndexTTS-2 must register a **`gpu.weight.index` knob in `registry.ts`** (with a `GPU_WEIGHT_INDEX`
  env, like `gpu.weight.qwen`) **and** update the budget help-text that hard-lists the per-engine
  weights. A measured weight comes out of the spike. OOM-prevention rests on **load-time eviction +
  sequential design/perform phases**, not the token count. (fs-45 telemetry records but does not yet
  drive eviction.)

### Install

- New `scripts/install-indextts2.{ps1,sh}` fetching weights with `hf download IndexTeam/IndexTTS-2
  --local-dir server/tts-sidecar/voices/index/` (not `git lfs clone`).
- Python deps pinned in `requirements/nvidia-cuda.txt`: the `index-tts` package + its torch /
  flow-matching / BigVGAN deps. **The install must verify the pins resolve against the existing venv
  (Integration shape).** AMD/CPU left to a follow-on.
- **Ships by default:** the "whisper" emotion-ref clip + the bundled seed library under `voices/index/`.
- **License compliance (concrete, v2):** the install **(a)** drops the **verbatim `LICENSE.txt` +
  copyright notice** into `voices/index/` (satisfying §3.4(b) notice-retention, not a summary), **(b)**
  records the **license version + weights hash** (§License version pinning), and **(c)** prints the
  license summary + obligations at install time so they surface at the point of opt-in.
- **Not** in the release zip (weight size; same user-fetch posture as Kokoro/Coqui).

## The 8GB bet (the core engineering question)

8GB is the target, and it is exactly what is unproven. **The budget is a four-stage problem, not a
one-lever problem.** Levers, honestly weighted:

1. **Vector-path emotion → the Qwen3-1.7B `emo_text` module is never instantiated.** This removes one
   *optional* model from the **worst case**. It is a free consequence of the integration spine — but
   it is **not** the load-bearing saving: the module is never loaded on our path, so its absence is a
   *default*, and the **three always-resident stages (T2S AR transformer + S2M flow-matching +
   BigVGANv2), all of unpublished size, are what decide the fit.** Treat the resident-three footprint
   as *the* unknown.
2. **Evict the analyzer Ollama during synth** (existing behavior).
3. **Sequential stage-loading / vocoder CPU-offload** (build-it-yourself; no IndexTTS-2 precedent).
4. **DIY quantization** (int8/int4) — **no public patch exists**, so real work; last resort; flag both
   the quality risk (low-bit most threatens the very expressiveness that is the selling point) **and**
   the §4.1(c) anti-distillation re-verify (§Gate 2).

**Unknowns the spike must resolve — VRAM (all four stages) AND RTF (named drivers, v2):**

- **Full resident VRAM, per stage.** Measure T2S, S2M, **and BigVGANv2 activation memory** (BigVGAN is
  a heavyweight neural vocoder; its activations at audiobook sample rates can spike on long segments)
  — not just "peak." The acceptance bar (≤8GB) is meaningless if the budget only models one stage.
- **AR KV-cache peak under a long sentence.** The T2S stage grows a KV cache token-by-token; the peak
  under chapter-length lines including OS headroom (~1–2GB Windows idle) is what matters.
- **Flow-matching NFE / step count.** S2M is flow-matching; flow/diffusion RTF is dominated by the
  number of function evaluations (sampling steps) — a tunable the default may set high. **Find the
  tuned step floor;** this can be a 5–10× RTF lever and is *not* just "set a threshold."
- **AR sequential decode at chapter scale.** T2S is autoregressive — token-by-token, latency scales
  with output length and compounds across thousands of sentences. **Measure at chapter scale, not a
  demo sentence.**
- **Does chunking actually help an AR model?** v2 correction: chunking is asserted as the VRAM-peak
  rescue, but chunking an *autoregressive* model can *hurt* RTF (per-chunk prompt/KV re-priming).
  **Validate** that chunking holds the VRAM peak *without* regressing AR throughput, and measure the
  per-chunk re-prime cost — don't assume it's free.

If no combination holds 8GB at acceptable speed/quality, the item **falls to a 16GB-class Could**
beside Fish (§Fallback), and the "on hardware you already own" headline is lost. **An 8GB model that
overflows is no more shippable than Fish's unavailable 16GB — neither is a settled advantage.**

### Fallback ladder (honest about what each rung saves)

1. Vector-path + Ollama-evict + (validated) chunking + tuned NFE holds 8GB at usable RTF → **the
   re-triage-to-Should case.**
2. Needs 12–16GB → ship as a 16GB-class **Could**, beside Fish; the "8GB" headline is gone — trigger a
   *should-we-even-ship-two-16GB-engines* re-evaluation, since Fish then has the better VRAM evidence.
3. The **emotion-decoupling quality gate** (Acceptance #3, upstream #433) *or* the **better-than-Qwen
   gate** (Acceptance #4) fails at every precision → **the item parks** — an engine no better than the
   resident Qwen isn't worth its VRAM.

## Integration seams (indicative — plan-time detail)

_Names verified against today's `main` to size the work; not a frozen contract. The load-bearing
dependency for go/no-go is **srv-43** (per-character `voiceUuid`). fs-49 mirrors fs-48's seam list so
the two are easy to compare._

**Sidecar (Python):**
- `server/tts-sidecar/main.py` — `IndexTts2Engine` in `ENGINES`; in-process **or** HTTP-child per the
  spike; ASR-style whole-engine idle-evict. Maps our `Emotion` → `emo_vector` (`neutral` → all-zero;
  `emo_alpha` v1 = 1.0); routes `whisper` → `emo_audio_prompt` (bundled clip), `all-zero`+log if absent.
- `server/tts-sidecar/requirements/nvidia-cuda.txt` — `index-tts` + deps + pins; **venv-collision
  check** at install.
- `server/tts-sidecar/scripts/install-indextts2.{ps1,sh}` — `hf download`; drop verbatim `LICENSE.txt`
  + notice; record license-version + weights-hash; print summary.
- `voices/index/` — cached per-character timbre clips + the bundled whisper clip + seed library +
  `LICENSE.txt`.
- New `server/tts-sidecar/tests/test_indextts2.py`.

**Server (Node/TypeScript):**
- `server/src/tts/model-keys.ts` — add `index_tts2` to `TtsEngine`; an `index-tts2` `TtsModelKey`; a
  label; arm `isTtsModelKey()`, `engineForModelKey()`, `canonicalModelKeyForEngine()`,
  `sidecarModelId()`. *(These four exist and are correctly named — verified.)*
- `server/src/tts/voice-mapping.ts` — clone-only handling + an `indexStorageKey` mirroring
  `qwenStorageKey` (**depends on srv-43 `voiceUuid`**); `pickEmotionVariantVoice` stays a no-op for
  `index_tts2`; extend the private `catalogForEngine` / `describeVoice` / `auditEngineCatalog` for the
  seed-library catalog.
- `server/src/tts/synthesise-chapter.ts` — per-character routing on `index_tts2`; **the per-quote
  `Emotion` → `emo_vector` map lives here**; generalise `applyQwenFallback`'s hardcoded `=== 'qwen'`
  guard (see Fallback below); **do not** copy Qwen's `synthesize_batch` path (per-call, like Coqui).
- `server/src/analyzer/fill-tone.ts` — _not modified._ Noted only to keep two signals distinct: the
  per-character `tone` {warmth,pace,authority,emotion} 0–100 is a **different *kind* of signal** from
  the per-quote `Emotion`. **`tone` is a character constant; the `emo_vector` is per-line.** v1 drives
  emotion from the per-quote `Emotion` *only*; any future blend of `tone.emotion` into the vector
  (parked, Out-of-scope) **must keep per-line `Emotion` authoritative** — it is a category mix of two
  different signals into one channel, not a free "refinement."
- `server/src/tts/engine-health.ts` — add `'index'` to the `EngineId` union; **leave out of the
  `STANDARD` set** so `engineTier ⇒ secondary`.
- `server/src/routes/sidecar-health.ts` + `routes/models-inventory.ts` — per-engine install/health
  state (`not-installed | weights-missing | ready | loaded`), mirroring `qwen_install_state`.
- `server/src/config/registry.ts` — `gpu.weight.index` knob (+ `GPU_WEIGHT_INDEX`), budget help-text
  update, idle TTL.
- The voice-design route — accept the "capture Qwen clip → IndexTTS-2 timbre" flow; mint the
  IndexTTS-2 `voiceUuid`.

**Frontend (React/TypeScript):**
- `src/views/cast.tsx` — engine picker exposes IndexTTS-2 when installed.
- `src/components/ModelControlPill.tsx` — IndexTTS-2 health card + Load / Stop / Repair (the real
  Model-Manager component); the load action shows the cold-load state (§Lifecycle).
- The model inventory surfacing — `models-inventory` route read into **local component state**
  (`model-manager.tsx` / `ModelControlPill.tsx`); **not** Redux (no models slice).
- Voice-picker UI — the seed-library picker + the describe-in-Qwen authoring entry; **no per-emotion
  variant designer for this engine** (native emotion replaces it).
- **Attribution surface (v2):** a "Built with IndexTTS-2 (bilibili Model Use License)" credit on the
  same user-facing surface where other engine credits appear (e.g. `/about` / the engine picker) —
  parity with how fs-48 commits to surfacing its attribution.

**Docs:** a regression plan under `docs/features/`; `INDEX.md` entry; INSTALL/README engine list + the
license/attribution notice.

### Fallback + multilingual (a known gap, not a solved fallback)

`applyQwenFallback` is **hardcoded to `route.engine === 'qwen'`** and falls back **only to
English-only Kokoro**, throwing `MissingDesignedVoiceError` when `forbidKokoroFallback` (non-English
books). So (a) the guard must be **generalised** to fire for IndexTTS-2, and (b) **multilingual
coverage is unverified** — the research found *no* confirmation of languages beyond English/Chinese
(benchmarks en/zh only), and **Russian support is an open question** (load-bearing for our RU books).
Until confirmed, an undesigned non-English IndexTTS-2 character has **no graceful fallback** — a hard
error, same honest posture as fs-48. **Russian coverage is an explicit Acceptance item (#6).**

## Acceptance criteria (the spike's pass/fail bar)

1. A cast member can be assigned an IndexTTS-2 voice (timbre captured from a Qwen-designed clip, or a
   bundled seed clip), and a chapter generates end-to-end with **per-sentence emotion driven from our
   existing per-quote `Emotion` via `emo_vector`** (`neutral` → all-zero; `emo_alpha` = 1.0) — no
   per-emotion variant voices designed.
   - **1a.** `whisper` lines render via the bundled emotion-ref clip; with the clip removed, they fall
     back to all-zero **and log the gap** (both branches verified).
2. **8GB primary bet (hardware-gated spike, the re-triage trigger):** on a real 8GB consumer card, the
   **vector-path** build (Qwen3-1.7B module *not* loaded) generates a full chapter with **peak VRAM ≤
   8GB across all four resident stages** *including OS headroom* and *under a long sentence's KV cache*
   (chunked if needed and **validated not to regress AR RTF**), Ollama evicted, at **RTF ≥ a threshold
   set at spike time** (with flow-matching NFE tuned) — usable for chapter-length audio.
   - **2a.** Cold-load completes within a set budget with a user-visible loading state.
3. **Emotion-decoupling quality (make-or-break, upstream #433):** a subjective A/B confirms the
   *shipped weights* deliver timbre-stable, recognisable per-line emotion (the paper's GRL decoupling
   may not be realised in the release). If emotion bleeds the timbre or affects are indistinct, the
   headline fails.
4. **Quality vs the resident engine:** IndexTTS-2 is **audibly at least as good as Qwen** on the same
   lines (no public benchmark compares them — this A/B is the only evidence).
5. **Synthetic-clip clone fidelity:** a **Qwen-generated** timbre clip clones acceptably under
   IndexTTS-2 (unaddressed by every source — the whole "design in Qwen" flow rests on it).
6. **Russian / multilingual:** confirm whether IndexTTS-2 renders acceptable Russian (and any other
   target language); if English/Chinese-only, scope the engine to those and state it.
7. **License compliance surfaced & testable (v2):** the **verbatim `LICENSE.txt` + copyright notice is
   present in the installed weights dir**, the license-version + weights-hash are recorded, **and** the
   "Built with IndexTTS-2" attribution appears on the named user-facing surface. Enabling the engine
   shows the source-available / threshold-gated / re-verify-before-paid-tier summary.

## Testing approach

- **Sidecar pytest** — `test_indextts2.py` mirroring `test_kokoro.py`: load / synthesize / unload
  (in-process **or** process spawn/teardown per the spike), PCM + sample-rate header, idle-evict frees
  the whole engine, the **`Emotion` → `emo_vector` map** produces audibly distinct output per emotion
  (incl. `neutral` → all-zero), whisper routes to the clip path when present and to all-zero+log when
  absent. **Triple-gated SKIP** (venv / pytest / weights absent).
- **Server vitest** — `model-keys` and `voice-mapping` arms; the `Emotion → emo_vector` mapping table
  (incl. the label-order pin, `neutral → all-zero`, and the whisper-absent fallback); the **generalised
  fallback** (IndexTTS-2 English → Kokoro; non-English → `MissingDesignedVoiceError`);
  `pickEmotionVariantVoice` no-op for `index_tts2`.
- **Frontend vitest** — engine appears in the picker **only when installed**; **no** variant-emotion
  designer renders for an IndexTTS-2 character; the attribution credit renders; any drawer-nested
  overlay `createPortal`s to `document.body` (clip-path regression guard, PR #832).
- **Golden-audio** — add an IndexTTS-2 line to the opt-in golden tier once stable (deferred).

## Risks & dependencies

1. **8GB unproven + un-deskable + hardware-gated, and a four-stage budget** *(Gate 1 / make-or-break)*
   — no published params/VRAM/RTF; no community quant; the resident T2S+S2M+BigVGAN footprint (not the
   skipped 1.7B module) decides the fit. The whole re-triage hinges on the spike.
2. **RTF could be unusable, not just slow** — flow-matching NFE/step-count and AR sequential decode at
   chapter scale are first-order; chunking may not help an AR model. Named spike unknowns.
3. **Emotion-decoupling may not be realised in the shipped weights** *(upstream #433, single-sourced)*
   — A/B it, don't assume it.
4. **Quality vs Qwen is unproven** — benchmarks author-self-reported (IndexTTS-2 even "beats" human
   ground truth — a benchmark-optimism red flag) and **exclude Qwen/Fish/XTTS**.
5. **Synthetic-reference behavior unknown** — no source covers cloning from a TTS-generated clip; the
   authoring flow depends on it.
6. **Multilingual / Russian unverified** — benchmarks en/zh only; non-English fallback is a hard error
   until confirmed.
7. **License is a conditioned, version-sensitive, foreign-jurisdiction grant — not "permissive"**
   *(Gate 2)* — threshold-gated commercial use as published, but with an unresolved #228, an
   anti-distillation clause touching **three fs-49 surfaces** (authoring flow, fs-38, DIY quant),
   PRC-law/Shanghai-arbitration that is **effectively non-defensible for a solo dev**, and §8
   version-non-retroactivity. Re-verify + written confirmation before any **paid** exposure; pin the
   license version with the weights hash.
8. **In-process integration may be infeasible** *(spike output)* — `index-tts`'s torch/CUDA/BigVGAN
   pins may collide with the shared venv (documented prior scars), and in-process leak/fragmentation
   poisons the next engine on an 8GB budget; out-of-process is the default if either fails.
9. **srv-43 dependency** — per-character storage key needs the `voiceUuid` apparatus (mirrors Fish).
10. **VRAM weight is a guess** until the spike measures it; the semaphore is advisory, not an OOM guard.
11. **Label-order / API drift** — the 8-float vector order and inference param names vary across
    versions/wrappers; pin against the installed weights or every line mis-renders.

## Out of scope

- AMD/ROCm and CPU support (NVIDIA-CUDA first).
- IndexTTS-2's natural-language `emo_text` path (instantiates the Qwen3-1.7B module) — deliberately
  unused in v1; a "max-expressiveness, needs-more-VRAM" mode is a *possible* follow-on once 8GB is
  proven.
- Blending `emo_vector`/`emo_alpha` from the per-character `tone` axes — parked; it mixes a character
  constant into a per-line channel and must keep per-line `Emotion` authoritative (§seams).
- IndexTTS-2 as the engine behind user voice-cloning (fs-38) — a natural follow-on, but note the
  anti-distillation §4.1(c) interplay (§Gate 2).
- Inclusion in the release zip (weights are user-fetched).
- Promoting the seed-library age×gender taxonomy to a cross-engine `VoiceProfile` concept.

## Backlog framing

- **MoSCoW: Could now. A passing 8GB spike makes it *eligible for re-triage* to Should — not an
  automatic promotion.** A *hardware* result must not silently elevate a build whose **license**
  (paid-tier re-verify) and **quality** gates (#3/#4) are still open, and which carries the
  two-16GB-engines tradeoff vs Fish (Fallback rung 2). The re-triage is a **human judgment** weighing
  VRAM + RTF + quality A/B + license re-verify + the Fish tradeoff — the spike merely makes it
  *eligible*. So it is filed as a **Could** tagged **"8GB spike ⇒ re-triage candidate for Should;
  depends on srv-43 + license re-verify"** in `docs/BACKLOG.md`. Prefix `fs-`. **Next free id confirmed
  = `fs-49`** (fs-48 is the Fish sibling).
- Issue carries What / Acceptance / **Key files** / **Depends on (srv-43 + an 8GB hardware+quality
  spike + a license re-verify before any paid exposure)** / Benefit; a thin row lands in
  `docs/BACKLOG.md` under **Could**, linking this spec and the Fish sibling.
- **Benefit (user):** finer, **per-line emotional performance** from a single designed voice — the
  thing our pre-baked variant-voice flow does expensively and Qwen-only — driven by the emotion data we
  already detect. The evidenced upside over Fish is the **mechanism** (native per-line emotion on data
  we already compute); the **8GB fit, the quality-vs-Qwen win, and the license advantage are all
  unverified bets**, not settled wins. The headline risk is the unproven 8GB fit on a thinner evidence
  base than Fish.
