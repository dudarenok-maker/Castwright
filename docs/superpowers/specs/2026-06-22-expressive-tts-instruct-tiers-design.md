---
title: Expressive narration — Qwen instruct tiers, anchored variants, and LLM Script Review
status: draft
date: 2026-06-22
related:
  - fs-55 (#993) — acoustic variant-fidelity gate (this design closes it without building the gate)
  - side-19 (#988/#989) — Code2Wav torch.compile speed play (perf upside for the 1.7B tiers)
  - fs-25 (#479) — per-quote emotion enum (the field this builds alongside)
inspiration: github.com/Finrandojin/alexandria-audiobook (Alexandria — Qwen3-TTS audiobook tool)
---

# Expressive narration — Qwen instruct tiers + Script Review

## 1. Summary

Two capabilities, one combined spec, both **additive** (off → today's behaviour, exactly):

1. **Free-text per-line delivery direction ("instruct")** on the Qwen engine, surfaced as a
   hardware-gated quality/expressiveness ladder. This also **fixes the long-standing emotion-variant
   identity drift** (fs-55) at its root, and is the home for **non-verbal vocalizations** ("Ah!",
   "Haah…").
2. **LLM Script Review** — an optional, engine-agnostic second LLM pass that repairs common
   annotation errors after Phase-1 attribution.

The instruct work is grounded in an on-box feasibility spike (2026-06-22, RTX-class 8 GB card)
whose findings are recorded in §3 — every load-bearing claim was measured or heard, not assumed.

## 2. Background

**Source features (Alexandria, built on Qwen3-TTS):**
- *LLM Script Review* — optional second pass fixing five annotation-error classes.
- *Non-verbal sounds* — the LLM writes pronounceable vocalizations into the text plus a delivery `instruct`.
- Alexandria's data unit is `{ speaker, text, instruct }` where `instruct` is a free-text 2–3 sentence
  voice direction sent straight to the engine.

**Castwright today:**
- A `Sentence` is `{ id, chapterId, characterId, text, emotion? }`; `emotion` is a fixed 5-value enum
  (`neutral|whisper|angry|excited|sad`, `server/src/handoff/schemas.ts`). There is **no free-text instruct**.
- Per-line emotion is implemented as **pre-baked emotion-variant voices** (`maerin__angry`, `maerin__sad`):
  each is a *separately designed* Qwen voice; synthesis just selects the variant `.pt` to clone
  (`server/src/tts/synthesise-chapter.ts`, `voice-mapping.ts`).
- Qwen engine (`server/tts-sidecar/main.py`, `QwenEngine`): **0.6B Base** (resident synth, clones a cached
  `.pt`) + **1.7B VoiceDesign** (transient, design-time only). Installed `qwen-tts` is **0.1.1**.
- Default engine is Kokoro (no instruct support); Qwen is the engine this design targets.

## 3. Feasibility findings (the evidence base)

All from the 2026-06-22 spike (throwaway scripts; deleted after this lands). Voice under test:
`qwen-8434989a52184d08be265` (a designed ICL voice with angry/sad/excited/whisper variants).

**Engine mechanics:**
- `qwen-tts`'s public wrapper keeps clone and instruct as **separate, non-combinable modes**
  (`generate_voice_clone` is Base-only and takes no instruct; `generate_voice_design`/`generate_custom_voice`
  take instruct but no cloned identity). The `.pt` (`VoiceClonePromptItem`) is **identity-only**
  (codec `ref_code` + ECAPA `ref_spk_embedding`).
- **But** the raw `Qwen3TTSForConditionalGeneration.generate()` accepts **both** `instruct_ids` and
  `voice_clone_prompt` in independent, additive branches with **no `tts_model_type` guard** — so a
  thin path that bypasses the wrapper can do **cloned identity + per-line instruct in one call**.
- A 0.6B-designed `.pt` is **dimensionally incompatible** with the 1.7B (1024-dim vs 2048-dim speaker
  embedding). We **re-derive** a 1.7B-native ICL prompt by decoding the stored `ref_code` → reference
  clip → re-extracting on the 1.7B. No re-recording, no re-design.

**Heard (operator A/B):**
- Live instruct on a **cloned** 1.7B works: neutral/excited/sad land cleanly with **identity intact**.
- **ICL cloning is mandatory.** x-vector-only cloning *drifts identity* under strong instructs
  (whisper/angry → "different voice"); full **ICL** (conditioning on the reference audio codes) **holds
  identity** on every emotion incl. extremes. This is the unlock.
- Intensity at the extremes needs tuning (whisper "softer", angry "louder"; temperature 1.1 helped) —
  prompt-phrasing + sampling work, **not a blocker**.
- **1.7B (even with no instruct) is "definitely more expressive" than 0.6B** → the 1.7B is a genuine
  quality upgrade on its own.
- **Anchored-variant fix confirmed** ("sounds like the same person"): see §4.3.

**Measured (8 GB card, SDPA, no FA2):**
- No OOM. 1.7B Base ≈ 3.9 GB; 0.6B ≈ 1.2–2.1 GB.
- Single-sentence RTF ≈ 2.8–3.1 for **both** models (overhead-bound — model size barely matters here).
- **Batched (batch-8) is the lever — both tiers beat realtime.** Measured (SDPA, no FA2):
  0.6B same-voice **RTF 0.74 / 1.35× / 2.1 GB**; 1.7B same-voice **RTF 1.03 / 0.97× / 4.2 GB**;
  **1.7B mixed-voice + per-line instruct (the real Default path) RTF 0.67 / 1.49× / 4.22 GB.**
- **Per-line instruct costs ~nothing** (C1, measured 2026-06-22): the 1.7B mixed batch-8 is **identical**
  with vs without instruct (RTF 0.67, 17.9 frames/s both), and the raw-generate bypass **batches cleanly
  with heterogeneous voices + per-item instruct** (resolves the M2 "does it even batch" risk).
- **The 0.6B-vs-1.7B *speed* gap is within run-to-run noise** (1.7B measured 11.7 frames/s same-voice vs
  17.9 mixed-voice across two runs). So the 0.6B is the **low-VRAM tier** (~2 GB vs ~4.2 GB), **not** a
  proven speed tier — a controlled same-sentence A/B is needed before claiming any speed edge.

## 4. Architecture

### 4.1 Engine tiers (operator-selectable, hardware-gated)

| Tier | Path | Per-line delivery | Batched perf | VRAM | Role |
|---|---|---|---|---|---|
| **Fast** | 0.6B Base + anchored emotion-variant `.pt` | enum variant select | ~1.35× realtime | ~2.1 GB | **low-VRAM** (speed edge within noise) |
| **Default — Quality+Expressive** | 1.7B Base + **ICL** clone, **per-line instruct optional** | live instruct (fallback: emotion) | **~1.5× realtime (RTF 0.67); instruct ≈ free** | ~4.2 GB | best quality; default |

The earlier "three tiers" collapses to **two**: a 1.7B-ICL default that carries optional per-line
instruct (plain when absent, expressive when present), and a 0.6B Fast/low-VRAM tier. Quality and
"expressive" are not separate tiers — they're the same 1.7B path with instruct optional per line.

### 4.2 The instruct mechanism

- Add a thin sidecar synth path that calls raw `model.generate(input_ids, ref_ids, instruct_ids,
  voice_clone_prompt=…)` on the **1.7B Base**, replicating the wrapper's ICL handling (build `ref_ids`
  from `ref_text`; prepend `ref_code`, then trim the ref-prefix from the decoded wav) and **adding**
  `instruct_ids` built as `tokenize("<|im_start|>user\n{instruct}<|im_end|>\n")`.
- ICL is required (carries identity + prosody). Sampling default temperature ≈ 0.9–1.1 (tunable per
  intensity).
- The 1.7B Base must be wired into setup (§4.8).

### 4.3 Anchored emotion variants (fixes fs-55)

**Root cause of today's drift:** each emotion variant is an *independent* VoiceDesign generation —
same persona text + a one-line emotion suffix, but a *freshly sampled voice each time* (confirmed from
the `.json` sidecars: persona text is preserved, only "Delivered angrily…"/"…hushed whisper" is
appended; the drift comes from re-sampling + the suffix biasing the sampled identity, worst at the
extremes).

**Fix (validated by ear):** mint each emotion's reference clip via the **same instruct machinery at
*design* time** — 1.7B-ICL-clones the *base* identity + emotion instruct on calibration text → a clip of
*the base voice performing that emotion* → distill to a **0.6B ICL `.pt`** (the variant **must** be ICL;
the emotion lives in `ref_code`, x-vector-only loses it). All variants now share one identity → drift
gone by construction, including for Fast-tier (0.6B) users who never touch the 1.7B at synth.

So the instruct capability does **double duty**: live per-line direction (Default tier) and anchored
variant minting (Fast tier).

### 4.4 Data model (additive)

- Add **optional** `instruct?: string` to the `Sentence` schema, **alongside** `emotion` (never instead).
  Existing data without `instruct` stays valid; nothing migrates.
- `emotion` keeps its exact current meaning and drives Fast-tier variant selection unchanged.
- Default tier reads `instruct`; absent → derive a phrase from `emotion`; absent → neutral. A book
  analyzed before this feature plays fine on every tier.

### 4.5 Analysis: emitting instruct + non-verbal sounds

- Phase-1 keeps emitting `emotion` exactly as today; `instruct` is *additional* output (cleanest as an
  opt-in emit or a separate backfill pass — mirroring fs-33's emotion backfill — so speaker-attribution
  accuracy never regresses to gain instruct).
- **Non-verbal sounds** ride the same field: the LLM writes pronounceable vocalizations into `text`
  ("Ah!", "Haah…", "Haha!") plus a matching `instruct`. No new surface.
- Instruct is emitted in a **bounded, tuned "dialect"** (the spike showed phrasing/intensity matters),
  not arbitrary prose — a style guide the analysis prompt follows.

### 4.6 LLM Script Review (engine-agnostic)

Optional second LLM pass over Phase-1 output, slotting in **after attribution, before
`manuscript-edits.json` is written**, operator-triggered ("Review Script") with an accept/reject diff.
Repairs five error classes: strip attribution tags from dialogue; split narration out of dialogue
entries; extract dialogue from narrator runs; merge over-split narrator entries; validate/repair
`instruct` fields. No GPU/Qwen involvement — shippable independently of the instruct tiers.

### 4.7 VRAM invariant (hard constraint)

Never two heavy models co-resident. VoiceDesign/1.7B is offloaded before generation; exactly one Base
model resident at a time. Anchored-variant minting (1.7B) and Fast-tier synth (0.6B) run in **separate
phases**, never together. This keeps the plan-108 8 GB OOM impossible.

### 4.8 Infrastructure

- **Wire `Qwen/Qwen3-TTS-12Hz-1.7B-Base` into setup** — `install-qwen3.mjs` (`BASE`/model consts) and
  `QwenEngine` model ids. Not downloaded on a normal install today.
- **FA2 = conditional + fix the stale pin.** `install-qwen3.mjs` currently pins
  `flash_attn-2.7.4+cu124torch2.6.0…cp311-win_amd64.whl` with a cp311 gate, but the venv is **Python
  3.12.10 / torch 2.11.0+cu128**, so FA2 silently skips (SDPA in use). Make FA2 auto-install + activate
  (`QWEN_ATTN_IMPL=flash_attention_2`) **only when a matching cp312/torch2.11/cu128 Windows wheel
  exists**; SDPA fallback otherwise. **Do not downgrade torch for FA2** — its win is modest on short
  TTS decode; batching is the bigger lever.

## 5. Operator controls

- A per-user/per-book engine-tier selector (Fast 0.6B ↔ Default 1.7B), defaulting to the 1.7B where the
  card allows (≥ ~6 GB free) and falling back to 0.6B on tight VRAM.
- Instruct is on by default within the 1.7B tier (additive; degrades to emotion/neutral when absent).

## 6. Non-goals

- Replacing the `emotion` enum (kept; additive only).
- True per-line instruct on the **0.6B** at synth (it lacks the capability; the 0.6B gets *anchored
  variants* instead).
- Downgrading torch, or building FA2 from source as part of *this* work (the source build is a separate
  exploration item — §10).
- Instruct on Kokoro/Coqui (Qwen-only capability).

## 7. Open questions / tuning debt

- **Instruct intensity tuning** — whisper softer, angry louder; settle phrasing vocabulary + sampling
  (temperature) per emotion. The Default tier's quality depends on this dialect.
- **Tier-selection UX** — auto-pick by detected VRAM vs explicit operator choice (likely both: auto
  default + manual override).
- **Anchored-variant migration** — existing drifting `.pt`s: regenerate lazily on next design, or a
  one-shot re-mint pass for already-designed books.

## 8. Delivery (proposed waves)

1. **Script Review** (engine-agnostic, no GPU) — could land first; immediate annotation-quality win.
2. **Infra** — 1.7B Base wiring; FA2 conditional + pin fix.
3. **Instruct synth path** — raw-generate ICL+instruct on the 1.7B; `instruct?` schema field; tier selector.
4. **Anchored variants** — design-time minting via 1.7B-ICL+instruct → 0.6B `.pt`; **Closes #993 (fs-55)**.
5. **Analysis** — emit `instruct` + non-verbal sounds (additive / backfill).

(Single combined spec; waves are an ordering aid, delivered per the project's branch/PR conventions.)

## 9. Testing & acceptance

- **Golden-audio** (`test:golden-audio`): add a Qwen instruct fixture asserting (a) identity stability
  across instructs (speaker-embedding distance within tolerance) and (b) audible delivery change.
- **Anchored variants**: regression that a minted variant's speaker embedding stays within tolerance of
  the base (the measured fix for fs-55).
- **Script Review**: unit fixtures per error class (before/after annotation); one e2e for the
  operator-triggered review + accept/reject diff.
- **Perf guard**: record batched RTF for both tiers so a regression surfaces (baseline numbers in §3).
- **Sidecar pytest**: cover the raw-generate ICL+instruct path and the dim-incompatibility re-derivation.

## 10. Backlog / issue linkage (filed 2026-06-22)

- **fs-56 (#996)** — per-line instruct on the Qwen 1.7B tier (this design's core). **Resolves fs-55 (#993)** — `Closes #993` on the anchored-variants wave, **gated on the re-mint migration** (see §11 M4); root cause prevented, detection gate not built.
- **fs-57 (#997)** — non-verbal vocalizations (pronounceable text + instruct). **Sibling of `side-18` (#979)** which covers the same goal for the other bracket-cue-native engines (reframed, not closed).
- **fs-58 (#998)** — LLM Script Review.
- **side-20 (#999)** — wire 1.7B-Base into setup. **side-21 (#1000)** — FA2 stale-pin fix + conditional enable. **side-22 (#1001)** — explore FA2 source build for Windows cp312/torch2.11/cu128 (publish wheel; no Windows torch-2.11 wheel exists today).

## 11. Adversarial review — resolutions (2026-06-22)

This spec stays `draft` until **C2** is satisfied. Findings below amend the sections cited.

- **C1 — Default-tier perf was unmeasured → RESOLVED.** Measured 1.7B mixed-voice batch-8 **+ per-line instruct = RTF 0.67 / 1.49× / 4.22 GB**, identical to no-instruct (instruct ≈ free); raw bypass batches mixed voices + per-item instruct. §3/§4.1 updated. The 0.6B "speed tier" claim is downgraded to **low-VRAM tier** (gap within noise).
- **C2 — Validation is thin → OUTSTANDING (gates leaving `draft`).** Audio findings are one voice / one English sentence / ~5 emotions, plus a 3-voice perf run. **Required before the plan is complete:** a validation matrix (several voices × sentence types incl. long/questions/dialogue × all emotions × language) with the identity metric of M7.
- **M1 — Script Review can corrupt sentence IDs → amend §4.6 + §9.** Re-split/merge MUST preserve sentence-ID stability and not orphan emotion/instruct assignments or generated audio (`segments.json`); must respect prior user manual edits. Add a regression fixture.
- **M2 — raw-`generate` bypass is version-fragile → amend §4.2.** Pin `qwen-tts` (0.1.1) and add a sidecar test that fails loudly if the raw path drifts; consider an upstream PR to expose clone+instruct officially. (Batching with mixed voices + instruct is confirmed working.)
- **M3 — Fast tier depends on the 1.7B *Base* → amend §4.3/§4.8.** Anchored-variant minting needs the 1.7B **Base** (VoiceDesign can't clone) — a genuinely new ~3.4 GB model + design-time run, **including for Fast/0.6B users**. Not "no new dependency." (side-20 #999 notes this.)
- **M4 — closing fs-55 leaves existing drift undetected → amend §7/§10.** `Closes #993` only after the **re-mint migration** runs over already-designed books; until then keep a lightweight fidelity check so pre-existing drifted variants aren't silently shipped.
- **M5 — non-verbal sounds collide with two systems → amend §4.5.** Script Review (fs-58) must NOT strip intentional vocalizations; ASR content-QA (srv-31) needs a WER carve-out so inserted vocalizations don't trigger spurious re-records.
- **M6 — FA2 "auto-enable" oversold → amend §4.8.** There is no discovery mechanism and no matching Windows wheel today, so FA2 is effectively **off until the pin is manually updated** (side-21/side-22). State it as such.
- **M7 — identity metric undefined → amend §9.** Specify: ECAPA speaker-embedding cosine distance from the model's own encoder, with a tolerance **calibrated against perceived identity** on a small labelled set (don't assume distance ⇔ perception).
- **M8 — `instruct?` is OpenAPI-governed → amend §4.4.** Add the field to `openapi.yaml` and regenerate `src/lib/api-types.ts`; the Zod `schemas.ts` change alone is insufficient (OpenAPI is the type source of truth).
- **Minors:** mixed-voice batch now measured (C1); per-line **temperature** strategy is tuning debt (1.1 helped angry, may hurt whisper); **Script Review keeps a clean wave boundary** so it can ship alone first; **fs-45** VRAM telemetry (#845) should feed the §5 tier auto-selector; **non-English vocalizations** (fs-2 Russian) deferred.
