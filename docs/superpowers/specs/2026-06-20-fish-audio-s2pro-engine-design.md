# fs-48 — Fish Audio S2-Pro TTS engine (premium-quality tier)

- **Date:** 2026-06-20
- **Issue:** _to be filed_ (`area:fs`, `moscow:could`, `type:feat`)
- **Branch:** _none yet — backlog Could item; spec only_
- **Status:** approved design (brainstormed + two adversarial reviews folded in) — captured as a
  future Could item, not slated for build
- **Revision note:** v2 corrects v1's factual and codebase claims after two adversarial reviews
  and a dedicated 16GB-feasibility research pass. Material changes: **16GB is the primary target**
  (per product steer — 24GB cards are out of reach for most local users), reached via **BNB NF4
  4-bit** (the chosen quant; FP8 is really a 20GB path, GGUF is too slow); license terms are
  stronger with personal-use as the through-line; **in-process PyTorch reuse is the preferred
  integration** (NF4/`bitsandbytes` is pure torch), with an out-of-process HTTP child as the
  documented fallback; several v1 file/function names were wrong and are corrected below.

## Summary

Add **Fish Audio S2-Pro** as a fourth, **opt-in** synthesis engine alongside Kokoro, Coqui
XTTS, and Qwen, for **quality-chasing users on a 16GB consumer GPU**. S2-Pro is a ~4.4B-param
zero-shot **clone** model (a 4B "slow AR" semantic stage + a 400M "fast AR" acoustic stage, a
Dual-AR architecture) with free-form inline tone tags and ~80-language coverage (incl. Russian).

It is **not** a default engine and **not** auto-installed. You opt in through the Model Manager
(like Coqui today), and it loads on demand and evicts when idle — resident only while in use.

**Target is 16GB — deliberately.** The whole point of this item is to reach users on
**16GB consumer cards** (RTX 4060 Ti 16GB / 4070 Ti Super / 4080-class); **24GB cards are out
of reach for most local users**, so a 24GB-only engine would miss the audience. fishaudio's
*official* recommendation is ~24GB and they declined to ship a 16GB-fitting path themselves
(issue #1168, closed "not planned") — but the **consumer ecosystem already runs S2-Pro on
≤16GB via community 4-bit quantization** (BNB NF4; see §"The 16GB path"). So **16GB is the primary
design target**; **24GB is the comfortable fallback** for users who have it, and the
**full-precision 24GB path is the safety net** if the 16GB path can't hit an acceptable quality
or speed bar. The 16GB path is **measured, not assumed** — it's gated on the hardware spike
(§Gate 2 / §Acceptance). See §"The 16GB path" for the concrete approach.

S2-Pro's multilingual reach is a real incidental benefit but not the headline.

## Why this is a Could, and the two things that gate it

These shape the whole item and are stated up front so a future implementer inherits them.

### Gate 1 — License (personal-use through-line; commercial is the *user's* responsibility)

S2-Pro ships under the **Fish Audio Research License** (© 39 AI, INC.) — a **custom
source-available license, not CC-BY-NC or Apache**. The relevant facts (verbatim from the
LICENSE):

- **Personal / research use is permitted.** "Commercial Purpose" use — anything "primarily
  intended for or directed toward commercial advantage or monetary compensation" — **requires a
  separate written agreement** from Fish Audio (business@fish.audio). No commercial rights are
  granted by default.
- Redistribution / use must carry the attribution string and display **"Built with Fish Audio"**
  prominently.
- The model may **not** be used to create or improve a foundational generative AI model.
- Community FP8/GGUF derivatives inherit this same license.

**Product stance (decided):** Castwright ships the *integration* (code that drives the model);
the **user fetches the weights from HuggingFace and runs them locally for personal audiobooks**
under the research license. This **does not preclude personal use.** The product MUST make
clear — in-app at the point of enabling the engine, and in docs — that **creating audiobooks
*for sale* with S2-Pro requires the user to obtain their own commercial license from Fish
Audio**, and the **"Built with Fish Audio" attribution obligation** must be surfaced.

**Residual risk (flag, not a certification):** whether bundling the S2-Pro integration inside a
*paid* product (Cast Pass) is itself a "Commercial Purpose" is a legal judgment call. This spec
does **not** certify it as clean — it recommends a **legal sign-off** before the engine is
exposed in a paid tier, and treats personal/free use as the safe default. This belongs in the
issue's **Depends on**.

### Gate 2 — Proving the 16GB path (hardware-gated Task 0)

16GB is the target, and the consumer ecosystem already runs S2-Pro there — but **we must
measure it on our own pipeline before claiming it.** The spike is **hardware-gated:** it can
only run once a **16GB card is physically in hand**. Its job is to confirm a chosen
quantization path hits **peak VRAM ≤ 16GB at an acceptable speed and quality** (bar in
§Acceptance). The candidate paths and evidence are detailed in §"The 16GB path."

**Fallback ladder if the NF4 spike underperforms** (so the item never just dies):
1. Add **chunked synthesis** (ComfyUI-style chunk-length) to cap KV-cache peak; if still over,
   try the build-it-yourself sequential stage-load / codec CPU-offload.
2. If 16GB can't hit the VRAM/speed/quality bar, ship as a **20GB (FP8) or 24GB (full)**
   engine with 16GB marked experimental — still useful, just not the headline.
3. The GGUF/`s2.cpp` path covers sub-12GB/CPU users but at RTF≈3 — offer it only as an explicit
   "slow but tiny" option, never the default.
4. Only if *none* works does the item park.

## Engine architecture

### Integration shape — prefer in-process PyTorch reuse; out-of-process server is the fallback

**Preferred (the goal): reuse the existing sidecar PyTorch/CUDA stack in-process,** exactly like
Coqui and Qwen. fish-speech *is* a PyTorch project, and the chosen 16GB path — **BNB NF4 4-bit
via `bitsandbytes`** (§"The 16GB path") — is **pure PyTorch**, so in-process reuse is genuinely
viable, not wishful. The `groxaxo/fish-speech-int4-patch` already demonstrates the torch
`--bnb4` loader over the full dual-AR + codec pipeline; we vendor those modifications into
`FishAudioS2ProEngine` so it's a **normal in-process engine** in the `ENGINES` map: loads with
our device-selection (`cuda` → `mps`/`cpu`) and `bitsandbytes` 4-bit config, and its
`synthesize()` is a direct model call returning `SynthResult` (int16-LE PCM + rate). No new
process, no new IPC — the cleanest outcome, and it reuses the torch install we already pin.

**Fallback (only if the in-process torch path proves unworkable):** run the `groxaxo` patch (or
fish-speech's official SGLang server) as a **child process** and call its **OpenAI-compatible
HTTP API** (`:8880` for groxaxo), adapting the result into `SynthResult`. fish-speech's
officially documented entry points are CLI stages + the SGLang server, not a high-level Python
`synthesize()`, so if vendoring the raw torch `--bnb4` stages in-process proves too brittle,
this HTTP-child path is the known fallback. It's heavier — process lifecycle, health, port, and
teardown on `taskkill /T /F` for Windows parity — and documented here so it's not a surprise.
(The GGUF/`s2.cpp` runner is a *separate*, non-torch, Vulkan-based path — reserved for the
sub-12GB/CPU fallback only, given its RTF≈3.)

**Task 0 decides which.** The hardware spike must determine whether the in-process torch path is
viable on a 16GB card; the integration shape (and a chunk of the effort estimate) follows from
that answer. Either way, a thin `FishAudioS2ProEngine` registers in `ENGINES` under id
**`fish_audio_s2pro`** (short key `fish`) to satisfy routing; only its internals (direct torch
call vs. HTTP/subprocess adapter) differ. The base `Engine` class declares **only**
`synthesize(...)`; `unload()` / `_ensure_loaded()` / idle-evict are **per-engine conventions**
(Coqui/Qwen) Fish follows.

### Lifecycle

- **Opt-in, on-demand load** (`PRELOAD_FISH=0`); loading **evicts the analyzer Ollama** via the
  existing load-time eviction (the real OOM guard — *not* the semaphore), and vice-versa.
- **Idle-evict modelled on ASR, not Qwen-VoiceDesign.** Qwen's idle watchdog frees only the
  *transient* VoiceDesign model, leaving the resident Base synth loaded. S2-Pro is a single
  ~4.4B synth model, so its idle-evict must free the **whole engine** (and, in the out-of-process
  fallback, tear down its child process), mirroring `WhisperEngine.maybe_free_idle`, not the
  Qwen-VoiceDesign watchdog.
- **VRAM accounting is advisory, not a safety net.** The weighted semaphore arbitrates
  **unitless tokens, not GB** (`engine-vram-cost.ts`, "PROVISIONAL VALUES … not measured"); it
  clamps any cost above the budget down to capacity and **cannot prevent OOM**. Fish must
  register a **`gpu.weight.fish` knob in `registry.ts`** (with a `GPU_WEIGHT_FISH` env, like
  `gpu.weight.qwen`) **and** update the budget help-text that currently hard-lists
  "kokoro 1, qwen 1, coqui 3, analyzer 4, asr 1." A measured weight comes out of Task 0; until
  then it is a guess. **16GB co-residency support also requires recommending a larger
  `GPU_VRAM_BUDGET`** — the default budget (4, sized for 8GB) neither expresses 16GB headroom
  nor protects against OOM, so OOM-prevention rests on **load-time eviction + the measured
  weight**, not the token count. (fs-45 VRAM telemetry records but does **not** yet drive
  eviction.)

### Install

- New `scripts/install-fish-audio.{ps1,sh}` fetching the **base** weights with the official
  `hf download fishaudio/s2-pro --local-dir …` CLI (not `git lfs clone`) into
  `server/tts-sidecar/voices/fish/`; the repo is ~11GB (9GB LM + ~1.9GB codec). The **16GB NF4
  path quantizes the base weights on-the-fly via `bitsandbytes`** — no separate quantized
  download needed (unlike FP8, which would fetch a community FP8 checkpoint for the 20GB path).
- Python deps pinned in `requirements/nvidia-cuda.txt`: fish-speech + **`bitsandbytes`** (the
  NF4 dependency). AMD/CPU + the GGUF/`s2.cpp` (Vulkan) low-VRAM fallback left to a follow-on.
- **`bitsandbytes` NF4 requires a compatible CUDA build/arch** — the install script must verify
  it loads, since a wrong build silently breaks 4-bit.
- **Not** in the release zip (license + size) — same posture as Kokoro weights / Coqui.

## The 16GB path (the core engineering bet)

16GB is the target (§Summary), and the consumer ecosystem proves it's reachable — but only via
quantization, and the right quant matters. Evidence (community FP8/GGUF cards, the
`Saganaki22/ComfyUI-FishAudioS2` per-tier table, the `groxaxo/fish-speech-int4-patch`):

| Path | Peak VRAM | Speed | Verdict for us |
|---|---|---|---|
| Full bf16 (official) | **~17GB measured** (24GB rec.) | ~15-17 it/s | overflows 16GB — the 24GB fallback baseline |
| FP8 weight-only | ~12GB weights / **~20GB practical** | ~15 it/s | **NOT a clean 16GB fit**; a 20GB+ (Ada/Blackwell) path only |
| BNB INT8 (on-the-fly) | ~18GB | ~10-11 it/s | barely helps; NF4 strictly better |
| **BNB NF4 4-bit** | **~16GB** (claimed; 12GB on a 3060) | **~10-11 it/s** | **the chosen 16GB path** — any NVIDIA card, pure-torch via `bitsandbytes` |
| GGUF / s2.cpp (Q4-Q8) | 3-8GB | **RTF ≈ 3 (3× slower than real-time)** | sub-12GB/CPU fallback only; **too slow for audiobooks** |

**Chosen path: BNB NF4 4-bit.** It's the only one that fits 16GB at a usable speed, needs no
special FP8 hardware, and is **pure PyTorch + `bitsandbytes`** — so it aligns with the
in-process torch reuse we want (§Integration shape). The `groxaxo` patch (a fish-speech fork
exposing `--bnb4 --half`, lazy-load, full dual-AR + codec pipeline + voice cloning) is the
**reference implementation** — we either vendor its `--bnb4` modifications into our in-process
loader (preferred) or run its server as the out-of-process fallback.

**The evidence is thin — this is exactly why Task 0 exists.** Every credible number traces back
to two or three sources that quote each other; there is **no independent measured peak-VRAM for
NF4 on a real 16GB card** (the only *measured* peak anywhere is 17GB, unquantized, on a 48GB
card), and **no published RTF→seconds-per-sentence** for the NF4 tier. The spike must produce
our own numbers on our own pipeline.

**Two unknowns the spike must resolve, beyond "does it fit":**
1. **Quality at 4-bit.** S2-Pro's selling point is fine-grained *expressive prosody*; 4-bit
   quantization is most likely to degrade exactly that, and **no report has tested it.** If NF4
   guts the emotion control, the "premium quality" premise fails even if VRAM fits — fall back
   to FP8@20GB or full@24GB and drop the 16GB headline.
2. **Peak under a long KV cache.** 16GB-NF4 is a *claim*; a real 16GB card could OOM once the KV
   cache grows over a long sentence. Chunked synthesis (the ComfyUI `chunk-length` knob, 100-400)
   is the mitigation; the spike must confirm peak stays ≤16GB with desktop/OS headroom.

**Undocumented-but-plausible levers** (build-it-yourself, no S2-Pro precedent): sequential
stage-loading (load slow-AR → free → load codec) and CPU-offloading the codec stage. Only reach
for these if NF4 + chunking can't hold 16GB.

## Voice model (Qwen-style lifecycle, clone-from-seed — but it drags in real machinery)

S2-Pro has **no fixed voice catalog** — it is clone-only, so the **bundled seed-reference
library _is_ the catalog**. The cast UX follows the Qwen per-character bespoke-voice lifecycle,
but "mirror Qwen" is **not** a one-line delta; it pulls in the following, each of which Fish
must explicitly opt into or out of:

- **Per-character storage key + uuid (srv-43).** Qwen synth keys off `qwenStorageKey(voice,
  voice.id)`, which prefers the srv-43 `voiceUuid` (`qwen-${voiceUuid}`), minted/persisted at
  design time (`ensureCharacterVoiceUuid`) and used to name the per-character `.pt`/`.json`.
  Fish, being clone-only and per-character, needs its **own `fishStorageKey` + voiceUuid
  handling** mirroring this — it is a real subsystem, not free. **Depends on srv-43** landing.
- **Persona auto-generation.** Qwen's design route auto-generates a persona via Gemini when the
  text box is empty. Fish should decide whether to reuse this (the tone text feeds S2-Pro's
  inline tags) or skip it.
- **Prompt/clone cache** — Fish may cache the encoded reference-clip tokens; state the choice.
- **Batched synthesis — OPT OUT.** Qwen has a `synthesize_batch` path gated in
  `synthesise-chapter.ts`. Fish synthesizes **per-call** (like Coqui); do not copy the Qwen
  batch path.
- **A/B re-design compare** modal like Qwen's. **If drawer-nested it MUST `createPortal` to
  `document.body`** — the clip-path trap that clipped the Qwen voice-compare modal (PR #832).

**Design step (the genuine UX delta):** Qwen designs from a *text persona* with no audio.
S2-Pro's design input is a **seed reference clip + a tone/persona text box** (the text becomes
S2-Pro's free-form inline tone tags — the model supports 15,000+ tags, e.g. `[whisper]`,
`[professional broadcast tone]`, `[excited]`); the clip is cloned and cached. Reference length
is "a few seconds" (the often-cited "5–15s" is **not** a sourced fishaudio figure — treat as
approximate).

### Bundled seed-reference voice library (a first-class deliverable, with its own picker path)

A curated **age × gender grid** of short reference clips:

- **Age (5):** `child`, `teenager`, `young-adult`, `adult`, `elderly`.
- **Gender (3 per age):** `male`, `female`, `neutral`.
- → **~15 base seed cells**; more clips per cell later for collision-avoidance.

**This needs its OWN picker path — it does not slot into the existing `VoiceProfile` system.**
`VoiceProfile` is a closed 8-member union (`male-deep`…`narrator-cool`) and every engine catalog
is a `Record<VoiceProfile, string[]>` consumed by the private `catalogForEngine` / `describeVoice`
and `auditEngineCatalog`. A 15-cell age×gender grid **cannot** be keyed by `VoiceProfile`, so
Fish needs a **separate `pickVoiceForFish` path and its own catalog type** — the generic
catalog helpers do not extend to it. The existing buckets are roughly the **adult** row with
finer timbre granularity.

**Age-vocabulary mismatch to reconcile:** the analyzer emits `ageRange?: 'child' | 'teen' |
'adult' | 'elderly'` — **no `teenager`, no `young-adult`.** Any "pick the seed cell from the
character's detected age" logic needs an **explicit mapping table** (`teen → teenager`;
`young-adult` has no analyzer signal and must fall back, e.g. to `adult`) or it silently
misses. Likewise **`neutral` gender has no upstream auto-cast signal** (auto-casting keys off
male/female), so `neutral` is a *manual* selection only — state that.

**Sourcing constraint (deliberate).** Every seed clip must be **synthetic or properly consented
/ licensed** — no cloning of real people without consent, **sharpest for the `child`/`teenager`
rows** (audio of minors must be synthetic or consented/licensed, never harvested). Non-trivial,
ethically constrained asset work — part of the item, not an afterthought. **Broader misuse
note:** the engine also lets a user clone *any* uploaded clip, including a real child's — a
misuse surface the seed-sourcing rule does not cover; worth a usage/ToS line.

## Integration seams (corrected touch-list)

**Sidecar (Python):**
- `server/tts-sidecar/main.py` — `FishAudioS2ProEngine` registered in `ENGINES`; **preferred:
  in-process NF4/`bitsandbytes` torch loader** (vendored from the groxaxo `--bnb4` path);
  *fallback:* HTTP-child adapter. ASR-style whole-engine idle-evict.
- `server/tts-sidecar/requirements/nvidia-cuda.txt` — fish-speech + **`bitsandbytes`** + pins.
- `server/tts-sidecar/scripts/install-fish-audio.{ps1,sh}` — `hf download` base-weight fetch
  (NF4 quantizes on-the-fly; FP8 checkpoint only for the 20GB path).
- Seed-clip assets under `voices/fish/`.
- New `server/tts-sidecar/tests/test_fish.py`.

**Server (Node/TypeScript):**
- `server/src/tts/model-keys.ts` — add `fish_audio_s2pro` to `TtsEngine`; a `fish-s2pro`
  `TtsModelKey`; a label; arms in `isTtsModelKey()`, `engineForModelKey()` (else it falls
  through to `gemini`), `canonicalModelKeyForEngine()`, `sidecarModelId()`. *(These four exist
  and are correctly named — verified.)*
- `server/src/tts/voice-mapping.ts` — Fish's **own** catalog type + `pickVoiceForFish`; extend
  the **private** `catalogForEngine` / `describeVoice` switch bodies and `auditEngineCatalog`;
  a `fishStorageKey` mirroring `qwenStorageKey`. (`pickVoiceForEngine` / `pickEmotionVariantVoice`
  exist; the latter is a no-op for Fish.)
- `server/src/tts/engine-health.ts` — add `'fish'` to the `EngineId` union; **leave out of the
  `STANDARD` set** so `engineTier` ⇒ `secondary` (the real tier vocabulary is
  `'standard' | 'secondary'`, not "opt-in").
- `server/src/routes/sidecar-health.ts` + `routes/models-inventory.ts` — per-engine install /
  health state (`not-installed | weights-missing | ready | loaded`), mirroring `qwen_install_state`.
- `server/src/config/registry.ts` — `gpu.weight.fish` knob (+ `GPU_WEIGHT_FISH`) and the
  budget help-text update; idle TTL.
- `server/src/tts/synthesise-chapter.ts` — per-character routing on `fish_audio_s2pro`; and
  **generalise `applyQwenFallback`'s hardcoded `=== 'qwen'` guard** (see Fallback below).
- The voice-design route — accept S2-Pro's seed-clip + tone-text input; mint the Fish voiceUuid.

**Frontend (React/TypeScript):**
- `src/views/cast.tsx` — engine picker exposes Fish when installed.
- `src/components/ModelControlPill.tsx` — Fish health card + Load / Stop / Repair (the real
  Model-Manager component; there is **no** `server/src/model-control/` dir nor a
  `use-model-control.ts` hook — v1 named both wrongly).
- The models inventory state (Redux + `models-inventory` route) — install/tier surfacing.
- Voice-picker UI — Fish's age×gender grid + the tone/persona text box.

**Docs:** a regression plan under `docs/features/`; `INDEX.md` entry; INSTALL/README engine
list + the license/attribution notice.

### Fallback + multilingual (a known UX gap, not a solved fallback)

`applyQwenFallback` is **hardcoded to `route.engine === 'qwen'`** and falls back **only to
English-only Kokoro**, throwing `MissingDesignedVoiceError` when `forbidKokoroFallback` (non-
English books). So: (a) the guard must be **generalised** to fire for Fish, and (b) because
S2-Pro's headline is **multilingual**, an undesigned multilingual character has **no graceful
fallback — it is a hard error** (Kokoro can't cover non-English). This is called out as a
**known gap**, not papered over: the realistic expectation is "design the Fish voice before
generating," with a clear error otherwise.

## Acceptance criteria (the spike's pass/fail bar)

1. A cast member can be assigned an S2-Pro voice (designed from a seed clip + tone text), and a
   chapter generates end-to-end with that voice.
2. **16GB primary target (hardware-gated spike):** on a 16GB consumer card (e.g. RTX 4060 Ti
   16GB), the **NF4 4-bit** build generates a full chapter with **peak VRAM ≤ 16GB** *including
   OS/desktop headroom* and *under a long sentence's KV cache* (chunked if needed), at
   **speed ≥ a min RTF threshold set at spike time** — usable for chapter-length audio, not just
   a demo sentence. This is the bar the item lives or dies on.
3. **4-bit quality (the make-or-break quality gate):** a subjective A/B of **NF4 vs.
   full-precision** S2-Pro on emotional/expressive lines shows **no meaningful prosody
   degradation** — because 4-bit most threatens exactly S2-Pro's selling point, and no public
   report has tested it. If NF4 guts expressiveness, the 16GB headline is dropped (fall to
   FP8@20GB / full@24GB).
4. **24GB fallback (sanity baseline):** full-precision S2-Pro generates a chapter on a 24GB card
   with no OOM/recycle storm — the safety net behind the 16GB path.
5. **Quality vs. the resident engine:** S2-Pro (at the shipped precision) is **audibly at least
   as good as Qwen** on the same lines — an engine that isn't better than the resident one isn't
   worth the VRAM.
6. License/attribution surfaced: enabling the engine shows the personal-use / commercial-licensing
   notice and the "Built with Fish Audio" attribution.

## Testing approach

- **Sidecar pytest** — `test_fish.py` mirroring `test_kokoro.py`: load/synthesize/unload (the
  in-process NF4 path — or, for the fallback, process spawn/teardown), returns PCM + sample-rate
  header, idle-evict frees the whole engine, clone-from-seed produces audio. **Triple-gated SKIP**
  (venv / pytest / weights absent), like the golden tiers.
- **Server vitest** — `model-keys` and `voice-mapping` arms; the new Fish picker path + age
  mapping table; the **generalised fallback** (Fish English → Kokoro; Fish non-English →
  `MissingDesignedVoiceError`).
- **Frontend vitest** — engine appears in the picker **only when installed**; A/B compare modal
  portals to `document.body` (clip-path regression guard).
- **Golden-audio** — add a Fish line to the opt-in golden tier once stable (deferred).

## Risks & dependencies

1. **License** *(Depends on — legal sign-off)* — personal use OK; **commercial/for-sale use is
   the user's responsibility to license from Fish Audio**; mandatory "Built with Fish Audio"
   attribution; **legal confirmation needed** on bundling the integration in a paid tier.
2. **16GB unproven + hardware-gated** *(Task 0)* — the 16GB NF4 figure is a maintainer *claim*,
   never independently measured on a real 16GB card (only measured peak anywhere is 17GB
   unquantized); spike needs a physical 16GB card.
3. **4-bit quality is untested on prosody** *(make-or-break)* — NF4 most threatens S2-Pro's
   headline expressive control; if it degrades, the premium-quality premise fails.
4. **Integration shape is Task-0-dependent** — *preferred* is in-process PyTorch reuse (NF4 via
   `bitsandbytes` is pure torch, like Coqui/Qwen and what ComfyUI consumer users do); *fallback*
   is an out-of-process groxaxo/SGLang HTTP child if the in-process pipeline is too brittle. The
   GGUF path is a separate non-torch (Vulkan) runner. Effort estimate swings on which the spike confirms.
5. **srv-43 dependency** — Fish's per-character storage key needs the `voiceUuid` apparatus.
6. **`bitsandbytes` CUDA-arch dependency** — wrong build silently breaks NF4; install must verify it.
7. **Seed-voice sourcing + misuse surface** — synthetic/consented assets; clone-any-clip ToS line.
8. **No graceful multilingual fallback** — undesigned non-English Fish character = hard error.
9. **VRAM weight is a guess** until Task 0 measures it; the semaphore is advisory, not an OOM guard.

## Out of scope

- AMD/ROCm and CPU support (NVIDIA-CUDA first).
- Promoting the age×gender taxonomy to a cross-engine `VoiceProfile` concept.
- S2-Pro as the engine behind user voice-cloning (fs-38) — a natural follow-on once cloning ships.
- Inclusion in the release zip (weights are user-fetched, license-gated).
- Exposing the engine in a **paid** tier before the legal sign-off in Gate 1.

## Backlog framing

- **MoSCoW: Could.** Prefix `fs-` (full-stack engine). **Next free id confirmed = `fs-48`**
  (highest existing across GitHub issues is `fs-47`).
- Issue carries What / Acceptance / **Key files** / **Depends on (legal sign-off + srv-43 +
  16GB hardware spike)** / Benefit; a thin row lands in `docs/BACKLOG.md` under **Could**,
  linking this spec.
- **Benefit (user):** premium-quality, expressive, multilingual voices on a **mainstream 16GB
  consumer GPU** (NF4 4-bit) — bringing the best-quality engine within reach of quality-chasers
  who don't have a 24GB card, beyond what the default engines offer.
