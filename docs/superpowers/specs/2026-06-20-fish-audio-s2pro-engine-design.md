# fs-48 — Fish Audio S2-Pro TTS engine (premium quality, 16GB-card tier)

- **Date:** 2026-06-20
- **Issue:** _to be filed_ (`area:fs`, `moscow:could`, `type:feat`)
- **Branch:** _none yet — backlog Could item; spec only_
- **Status:** approved design (brainstormed) — captured as a future Could item, not slated for build

## Summary

Add **Fish Audio S2-Pro** as a fourth, **opt-in** synthesis engine alongside Kokoro, Coqui
XTTS, and Qwen. It targets **quality-chasing users on 16GB GPUs** — people who have headroom
beyond the 8GB default box and want the best timbre/expressiveness we can offer. S2-Pro is a
~4.4B-param zero-shot **clone** model (a 4B "slow AR" semantic stage + a 400M "fast AR"
acoustic stage) with inline tone control and 80+ language coverage.

It is **not** a default engine and **not** auto-installed. You opt in through the Model
Manager (like Coqui today), and it loads **button-driven** like Qwen — resident only while in
use, evicted otherwise. That lifecycle is what keeps it honest on a 16GB card.

The headline framing stays **"premium quality on a 16GB card."** Its multilingual reach
(including Russian) is a real incidental benefit but is not the pitch.

## Why this is a Could, and what gates it

Two facts shape the entire item and are written here so a future implementer inherits them
rather than rediscovering them:

1. **License boundary (the commercial gate).** Fish Audio S2 / S2-Pro is **source-available,
   not open-source**: weights are free for **personal and research** use, but **commercial
   use is restricted** and requires an agreement with Fish Audio. Castwright is a commercial
   product. Therefore this ships **opt-in only**, with the user fetching weights from
   HuggingFace under their own personal/research use — and a **Fish Audio commercial license
   is a hard prerequisite before S2-Pro could ever become a default or shipped-on engine.**
   This belongs in the issue's **Depends on**.

2. **16GB feasibility is a real engineering bet, not a given (the technical gate).** Real-world
   reports put **peak inference VRAM at ~17GB at full precision** — i.e. it *overflows* a 16GB
   card as-shipped (9GB FP16 checkpoint + activations + KV cache). The path to 16GB is **FP8
   quantization** (weights roughly halve to ~4.4GB; peak likely lands ~10–13GB) plus
   **streaming/chunked synthesis** to cap KV-cache growth. Whether a released FP8 build exists,
   or we quantize ourselves, or streaming is required, is **unresolved** — it is a **Task-0
   spike**. If a 16GB peak proves unachievable, the item's premise fails and it should be
   re-scoped (e.g. 24GB-only) or dropped.

## Engine architecture (mirrors the Qwen treatment)

- **New `FishAudioS2ProEngine(Engine)`** in `server/tts-sidecar/main.py`, registered in the
  `ENGINES` map under engine id **`fish_audio_s2pro`** (short key `fish`). Implements the
  existing `Engine` contract: `synthesize(model, voice, text) -> SynthResult` (int16-LE PCM +
  sample rate), idempotent `unload()` (`gc.collect()` + `torch.cuda.empty_cache()`), lazy
  `_ensure_loaded()`, and an idle-evict hook.
- **Lifecycle = Qwen's.** Lazy / button-driven `/load` (default `PRELOAD_FISH=0`); loading
  **auto-evicts the analyzer Ollama** and vice-versa (the existing inline "TTS / Analyzer
  unloaded to free VRAM" banner); an **idle-evict watchdog** (`FISH_IDLE_TTL`, mirroring the
  Qwen VoiceDesign / ASR watchdogs) frees it after inactivity. VRAM is accounted through the
  **weighted semaphore** with a new, **empirically-profiled** weight (provisionally heavy,
  e.g. `fish:4` — confirmed by the Task-0 spike, not assumed).
- **16GB strategy (the core bet).** Run the **FP8-quantized** weights; use streaming/chunked
  synthesis to cap KV-cache. This is the open risk from the §gate above.
- **Co-residency discipline.** On a 16GB card S2-Pro is heavy enough that it must not co-reside
  with another heavy model (analyzer, Coqui). The load path evicts the analyzer; the Model
  Manager must not allow an accidental Coqui `/load` on top (the plan-108 OOM lesson, applied
  to the larger card).
- **Install.** New `scripts/install-fish-audio.{ps1,sh}` fetching weights from HuggingFace into
  `server/tts-sidecar/voices/fish/`; Python deps pinned in `requirements/nvidia-cuda.txt`
  (AMD/CPU left to a follow-on). **Not** in the release zip (license + size) — same posture as
  Kokoro weights / Coqui.

## Voice model (Qwen lifecycle, clone-from-seed)

S2-Pro has **no fixed voice catalog** — it is clone-only. So the **bundled seed-reference
library _is_ the catalog**. The cast UX is otherwise the Qwen lifecycle:

- Each cast member carries `overrideTtsVoices.fish.name`; a voice is **designed during cast
  review**, cached per character, and reused at synthesis.
- **A/B re-design compare** modal like Qwen's. **Implementation note:** if the modal is
  drawer-nested it MUST `createPortal` to `document.body` — the known clip-path trap that
  clipped the Qwen voice-compare modal (PR #832).
- **Design step (the one delta from Qwen).** Qwen designs from a *text persona* with no audio.
  S2-Pro's design input is a **seed reference clip + a tone/persona text box**: the text becomes
  S2-Pro's inline tone tags (`[whisper]`, `[professional broadcast tone]`, `[pitch up]`), the
  clip is cloned, and the result is cached. Same lifecycle and UX; the only difference is a
  seed clip feeds the clone where Qwen needs none.

### Bundled seed-reference voice library (a first-class deliverable)

A curated **age × gender grid** of short reference clips:

- **Age (5):** `child`, `teenager`, `young-adult`, `adult`, `elderly`.
- **Gender (3 per age):** `male`, `female`, `neutral`.
- → **~15 base seed cells**; more clips per cell can be added later for collision-avoidance via
  the existing per-profile hash-selection pattern.

**Relationship to today's taxonomy.** This age×gender grid sits **alongside** the existing
per-engine profile scheme (`male-deep` / `female-mid` / `narrator-*`). Those existing buckets
are effectively the **adult** row, just with finer timbre granularity. **Out of scope:**
whether this age taxonomy is ever promoted to a cross-engine profile concept (Kokoro / Coqui /
Qwen) — that is a noted follow-on, not part of this item.

**Sourcing constraint (written in deliberately).** Every seed clip must be **synthetic or
properly consented / licensed** — no cloning of real people's voices without consent. This is
sharpest for the **`child` and `teenager`** rows: reference audio of minors must be synthetic
or consented/licensed, never harvested. This asset work is non-trivial and is part of the item,
not an afterthought.

## Integration seams (the touch-list)

Verified against the codebase — adding an engine is a known, bounded edit set:

**Sidecar (Python):**
- `server/tts-sidecar/main.py` — `FishAudioS2ProEngine` class + `ENGINES` registry entry +
  idle-evict watchdog wiring.
- `server/tts-sidecar/requirements/nvidia-cuda.txt` — Fish Audio package + torch-compat pins.
- `server/tts-sidecar/scripts/install-fish-audio.{ps1,sh}` — new weight-fetch script.
- Seed-clip assets under `voices/fish/` (or an env-overridable assets dir).
- New `server/tts-sidecar/tests/test_fish.py` (see Testing).

**Server (Node/TypeScript):**
- `server/src/tts/model-keys.ts` — add `fish_audio_s2pro` to `TtsEngine`, a `fish-s2pro`
  `TtsModelKey`, a display label, and arms in `isTtsModelKey()`, `engineForModelKey()`,
  `canonicalModelKeyForEngine()`, `sidecarModelId()`.
- `server/src/tts/voice-mapping.ts` — `FISH_S2PRO_PROFILE_VOICES` (the age×gender seed grid),
  `FISH_S2PRO_VOICE_DESCRIPTIONS`, and arms in `profileVoicesForEngine()` /
  `voiceDescriptionForEngine()`. `pickEmotionVariantVoice()` is a no-op for Fish.
- `server/src/tts/sidecar.ts` — health-probe shape for the new engine (`ready | loading |
  error`, install state).
- `server/src/config/registry.ts` — engine **tier = opt-in**, VRAM weight, idle TTL.
- `server/src/model-control/` — health card + Load / Stop / Repair action.
- `server/src/tts/synthesise-chapter.ts` — per-character routing on `ttsEngine ===
  'fish_audio_s2pro'` + fallback (undesigned → Kokoro for English, error otherwise, per the
  existing plan-146 fallback policy).
- Voice-design route — extend the design flow to accept S2-Pro's seed-clip + tone-text input.

**Frontend (React/TypeScript):**
- `src/views/cast.tsx` — engine picker exposes Fish when installed.
- Voice-picker UI — Fish voices surface from the seed grid; tone/persona text box in the design
  flow.
- `src/hooks/use-model-control.ts` + the models Redux slice — Model Manager integration
  (health, Load, Stop, Repair).

**Docs:**
- A regression plan under `docs/features/` (new number) from `TEMPLATE.md`.
- `docs/features/INDEX.md` entry; INSTALL / README supported-engines list.

## Testing approach

- **Sidecar pytest** — `test_fish.py` mirroring `test_kokoro.py`: load / synthesize / unload,
  PCM shape + per-response sample-rate header, idle-evict, and "clone-from-seed produces audio."
  **Triple-gated SKIP** (venv / pytest / weights absent), like the golden tiers, so it never
  blocks a box without weights.
- **Server vitest** — `model-keys` and `voice-mapping` arms for the new engine and the new
  age×gender seed buckets; routing + fallback in `synthesise-chapter`.
- **Frontend vitest** — the engine appears in the picker **only when installed**; the A/B
  compare modal structural test asserts it portals to `document.body` (the clip-path
  regression guard).
- **Golden-audio (deferred, noted)** — add a Fish line to the opt-in golden tier once the
  engine is stable; not part of the core item.

## Risks & dependencies

1. **License boundary** *(Depends on)* — source-available, personal/research only; **a Fish
   Audio commercial license is required before this can ever be a default/shipped engine.**
2. **FP8-on-16GB is unproven** *(gating spike, Task 0)* — must confirm a ≤16GB peak is
   achievable (released FP8 build vs. self-quantize vs. streaming). If not, the premise fails.
3. **Seed-voice sourcing** — curated age×gender library incl. child/teenager needs
   synthetic / consented audio; non-trivial, ethically constrained asset work.
4. **No fixed catalog** — everything is clone-based; the seed library is the only catalog.
5. **VRAM weight is an assumption** until profiled — the semaphore weight must be measured, not
   guessed.

## Out of scope

- AMD/ROCm and CPU support (NVIDIA-CUDA first; follow-on).
- Promoting the age×gender taxonomy to a cross-engine profile concept.
- Using S2-Pro as the engine behind user voice-cloning (fs-38) — a natural follow-on once
  voice cloning ships, deliberately kept out so this item stays self-contained.
- Inclusion in the release zip (weights are user-fetched, license-gated).

## Backlog framing

- **MoSCoW: Could.** Prefix `fs-` (full-stack engine). **Next free id confirmed = `fs-48`**
  (highest existing across GitHub issues is `fs-47`).
- Issue carries What / Acceptance / **Key files** / **Depends on (commercial license + FP8/16GB
  spike)** / Benefit; a thin row lands in `docs/BACKLOG.md` under **Could**, linking this spec.
- **Benefit (user):** premium-quality, expressive, multilingual voices for users who have a
  16GB card and are chasing quality beyond the 8GB default engines.
