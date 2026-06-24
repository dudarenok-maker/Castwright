---
title: fs-57 — Non-verbal vocalizations in narration with live context-aware instruct
status: draft
date: 2026-06-24
issue: fs-57 (#997)
related:
  - 2026-06-22-expressive-tts-instruct-tiers-design.md — parent spec (this drills §4.5 into a delivery)
  - fs-56 (#996) — per-line instruct on the Qwen 1.7B tier (tier *selection* shipped; live instruct *payload* did not — this spec builds it)
  - fs-58 (#998) — LLM Script Review (vocalization-protection guard already shipped + tested)
  - srv-31 (plan 186) — per-sentence ASR content-QA gate (gets the vocalization carve-out)
  - fs-33 (#596) — emotion-annotation backfill pass (the structural template for Stage 3)
  - reference: Qwen VoiceDesign persona/instruct stays English (accent rides a separate calibration channel)
---

# fs-57 — Non-verbal vocalizations + live context-aware instruct

## 1. Summary

Give narration lifelike non-verbal reactions — gasps, sighs, laughter ("Ah!", "Haah…",
"Haha!") — with no bracket-tag hacks, by teaching the analysis LLM to write **pronounceable
vocalizations into a sentence's `text`** plus a **matching free-text delivery `instruct`**, and
by making that `instruct` **audible end-to-end** through a live per-line instruct path on the
Qwen 1.7B Base.

This is the full vertical (the parent spec's "Option B"): data model + analysis emission +
runtime synthesis + the two guardrails (Script Review must not strip vocalizations; ASR
content-QA must not false-flag them). Everything is **additive** — a sentence without `instruct`
synthesises byte-identically to today.

**Scope correction vs. the parent spec.** The parent assumed fs-56 had already shipped a
per-sentence `instruct` field and a live instruct synth path. It had not: fs-56 shipped only the
1.7B **tier selection** scaffolding (per-character `ttsModelKey`, the "Higher quality (1.7B)"
toggle, `tts.preload.qwenBase17`, install-side 1.7B-Base prefetch). The `instruct` field and the
live synth payload **do not exist** and are built here.

## 2. Decisions (locked with the operator, 2026-06-24)

1. **`instruct` is a separate additive field**, not a replacement for `emotion` — they do
   different jobs (`emotion` = bounded enum; `instruct` = free-text live direction + the home for
   a vocalization's "how to perform it").
2. **Emit path = a first-class Phase-1 Stage 3** (Stage 1 cast → Stage 2 attribution+emotion →
   **Stage 3 instruct+vocalization**). Surfaced in the analysis form and wired to the **same
   operator trigger as the existing emotion-annotation button** (one action runs emotion +
   instruct/vocalization). Strict non-re-attributing envelope, like fs-33.
3. **Synthesis = unified live-instruct channel on the 1.7B**: one main base voice + per-line
   instruct, **no anchored multi-variants** on this tier — this is the model's intended use.
   Per-emotion intensity tuning is explicitly **deferred**. Anchored variants remain the **0.6B
   Fast-tier** mechanism, untouched.
4. **Vocabulary = open-ended / LLM-driven** (a style guide, not a hardcoded list) — chosen so the
   feature is **multilingual without per-language maintenance**.

## 3. The multilingual split (the key constraint this design respects)

The Qwen instruct channel is **English-coupled**: the model interprets the `instruct` text as
English regardless of the book's language (see the `reference_qwen_voicedesign_persona_english`
finding — persona/instruct stays English on a Russian book; accent rides a separate calibration
channel). So the two halves of a vocalization split by language:

| Field | Language | Source |
|---|---|---|
| Vocalization **`text`** (`"Ах!"`, `"¡Ay!"`, `"Haah…"`) | the **book's** language | LLM writes it natively — no hardcoded per-language list |
| Delivery **`instruct`** (`"a long, tired sigh"`) | **English** | LLM writes it in English — zero per-language maintenance |

This is why "open-ended" and "multilingual" are the *same* decision: an LLM-authored English
instruct + an LLM-authored native vocalization needs no per-language vocab tables. Supported
languages for vocalization *text* follow the existing language roster (en/es/ru live; fr/de ride
along since the instruct is English regardless).

## 4. Architecture

### 4.1 Data model (additive)

- Add **optional** `instruct?: string` to `sentenceSchema` (`server/src/handoff/schemas.ts`),
  `openapi.yaml` (Sentence schema), and regenerate `src/lib/api-types.ts` (`npm run
  openapi:types`). `sentenceSchema` is `.strict()` — add an **absent-still-parses** test so a
  pre-fs-57 analysis validates unchanged.
- Thread `instruct` through the synth grouping (`SentenceGroup` in
  `server/src/tts/synthesise-chapter.ts`, alongside the existing `emotion` carry at ~line 265).
- **Precedence ladder** (3-way, additive — absent `instruct` ⇒ today's behaviour exactly):

  > **manual edit › analyzer `instruct` › emotion-derived English phrase (1.7B only) › neutral.**

  Manual edits win (consistent with `emotion`'s "manual wins"). On the 1.7B tier a sentence with
  `emotion` but no `instruct` derives an English phrase from the enum; on the 0.6B tier `emotion`
  keeps driving anchored-variant selection unchanged.
- Manuscript edits are **not** cross-tab broadcast (`broadcast-middleware.ts`) — no sync worry;
  `instruct` follows `emotion`'s persistence (cast/manuscript state + manuscript-edits).

### 4.2 Analysis — Phase-1 Stage 3 (instruct + vocalization)

- **New skill** `skills/audiobook-instruct-annotation.md` + a `prompt.instructAnnotation` registry
  knob (user-forkable, live) + `runStage3Chapter` on the analyzer (mirror `runStage2Chapter` /
  the fs-33 emotion-annotation pass in `server/src/analyzer/gemini.ts` / `ollama.ts`).
- **Strict, non-re-attributing envelope** (the fs-33 invariant — never regress attribution to
  gain instruct): `{ annotations: [{ sentenceId, text?, instruct? }] }`. `text` is emitted only
  when the LLM inserts/edits a vocalization; `instruct` is the English delivery direction. No
  `characterId`, no re-splitting.
- **Open-ended dialect with a style guide** in the prompt: when the narrative makes a non-verbal
  reaction explicit (a gasp, sigh, laugh, hesitation), write the pronounceable vocalization into
  `text` in the **book's language** and an **English** `instruct`. Conservative — omit when not
  clearly signalled. Bounded by *guidance*, not an enum.
- **Stage flag for QA:** Stage 3 marks sentences it gave a vocalization (a boolean/marker
  persisted with the sentence) so the ASR carve-out (§4.4) is metadata-driven, not lexical.
- **UI wiring:** add Stage 3 to the analysis form; the existing emotion-pass operator button
  triggers Stage 3 alongside the emotion pass (one action). Exact button = the current
  emotion-annotation trigger (`src/views/manuscript.tsx` review/emotion control) — confirmed at
  plan time.
- Language preamble (`languagePreamble` in `gemini.ts`) gains a Stage-3 clause: vocalization text
  in the book's language, instruct in English.

### 4.3 Synthesis — unified live-instruct on the 1.7B Base

- **Promote `_icl_instruct_synth`'s mechanism into the batched generation path.** Today
  `_icl_instruct_synth` (`server/tts-sidecar/main.py:~1553`) is a single-shot **design-time**
  helper that calls raw `model.generate(instruct_ids=…, voice_clone_prompt=…)`. Lift its core
  (build `ref_ids` from `ref_text`, prepend `ref_code`, trim the ref-prefix, add per-item
  `instruct_ids`) into `synthesize_batch` so a single 1.7B-Base forward carries **per-item,
  heterogeneous `instruct_ids`** alongside the existing per-item voices. The spike measured this
  batches cleanly (mixed voices + per-item instruct, RTF 0.67 / 17.9 frames-s, instruct ≈ free).
- **One main voice, no variants on 1.7B.** The 1.7B tier stops selecting `__emotion` variant
  `.pt`s; emotion becomes an English instruct phrase (the §4.1 fallback). `pickEmotionVariantVoice`
  stays a strict no-op for everything except the **0.6B** Fast tier.
- **Sidecar request body** gains optional per-item `instruct`: `{ engine, model, items: [{ voice,
  text, instruct? }] }` (and the single `/synthesize` shape). Server side
  (`server/src/tts/sidecar.ts`) threads it from the resolved `SentenceGroup`.
- **Additive invariant — empty instruct reproduces today.** An item whose resolved `instruct` is
  empty builds empty `instruct_ids`, i.e. a plain ICL clone identical to the current
  `generate_voice_clone` output. Neutral sentences are byte-stable; mixed batches (some items
  with instruct, some without) are the normal case.
- **Version fragility (parent M2):** pin `qwen-tts` 0.1.1 and add a sidecar test that **fails
  loudly** if the raw-`generate` signature drifts (both `instruct_ids` and `voice_clone_prompt`
  accepted, no `tts_model_type` guard).
- **Batch packing (parent R2-M4):** per-item instruct adds variable tokens to the length-bucket
  batcher (`synthesise-chapter.ts:~536`). Decide whether instruct counts against
  `qwenBatchTokenBudget`; add a heterogeneous-instruct-length batch test so packing regressions
  surface.
- **VRAM / Base-swap (parent R2-M5):** the 1.7B-Base resident + idle-watchdog guards already
  exist (`_base17_activity`, `QWEN_BASE17_IDLE_TTL`, single-flight load lock). The live path runs
  on the **already-resident** 1.7B Base; the VRAM invariant (never two heavy models co-resident)
  is unchanged. Concurrent multi-book Base-tier pinning is per-run today (each generation POST
  pins its `modelKey`); document that a mixed 0.6B/1.7B concurrent render serialises Base loads at
  the sidecar (existing behaviour, not regressed here).

### 4.4 Guardrails

- **fs-58 Script Review — already protected.** `skills/audiobook-script-review.md:38-40` carries a
  tested "NEVER strip intentional non-verbal vocalizations" guard. fs-57 adds **one round-trip
  regression**: a sentence whose `text` is a vocalization **and** carries an `instruct` survives a
  Script Review pass unchanged (text not stripped, instruct not dropped). A `validate_instruct`
  Script-Review op stays **out of scope** (deferred follow-up, per fs-58 Unit B).
- **srv-31 ASR content-QA — marker-driven carve-out** (not a lexical allowlist — that can't scale
  to open-ended multilingual). In `classifyTranscript` (`server/src/tts/segment-asr-qa.ts`), a
  sentence flagged by Stage 3 as vocalization-bearing relaxes the verdict to `inconclusive`
  rather than `drift` (mirroring the existing `nameAllowlist` carve-out shape at ~lines 328-339).
  The gate is OFF by default and the 12-char `minChars` floor already short-circuits most bare
  interjections — so this is a narrow, targeted add, not a new subsystem.

## 5. Testing & acceptance

- **Schema:** `instruct?` absent-still-parses (`.strict()` safety); present round-trips through
  OpenAPI types.
- **Analysis:** Stage 3 fixture — given a manuscript line with an explicit reaction, the pass
  emits a native-language vocalization in `text` + an English `instruct`, with the strict envelope
  (no re-attribution). A negative fixture: an unsignalled line emits nothing.
- **Synthesis (sidecar pytest):** the batched ICL+instruct path produces per-item delivery change
  with identity intact; empty-instruct item is byte-equivalent to the plain clone; the
  drift-guard test for the raw-`generate` signature.
- **Golden-audio** (`test:golden-audio`): a Qwen instruct fixture asserting (a) identity stability
  across instructs (ECAPA cosine within tolerance) and (b) an audible delivery change.
- **Guardrails:** the Script-Review round-trip regression; an ASR carve-out unit test (a flagged
  vocalization sentence → `inconclusive`, not `drift`).
- **Perf guard:** record batched RTF with a heterogeneous-instruct-length batch so a packing /
  per-forward regression surfaces (baseline RTF 0.67 from the parent spike).
- **e2e:** the operator trigger runs Stage 3 alongside emotion and the analysis form reflects it
  (one Playwright spec on the analysis surface).

## 6. Non-goals / deferred

- No instruct on Kokoro / Coqui, nor live instruct on the **0.6B** synth (0.6B keeps anchored
  variants).
- **Per-emotion intensity tuning of the live instruct** is deferred (operator's call) — the 1.7B
  carries delivery on one main voice; calibration of whisper-softer / angry-louder phrasing is
  tuning debt, not a v1 blocker.
- A `validate_instruct` Script-Review operation class (defer to an fs-58 follow-up).
- fr/de vocalization *text* is unvalidated on a canary (rides along because the instruct is
  English regardless); es/ru vocalization text validated on their existing Coalfall canaries.

## 7. Open tuning debt

- Instruct phrasing vocabulary + sampling (temperature) per intensity — one temperature per
  batched forward may bound per-emotion control (parent R2-Mi).
- Whether instruct tokens count against `qwenBatchTokenBudget` (settle with the §5 packing test).

## 8. Delivery waves

1. **Data model + schema** — `instruct?` field, OpenAPI, types, precedence ladder, absent-parses
   test.
2. **Synthesis** — batched ICL+instruct on the 1.7B; sidecar body + server threading; additive
   invariant; drift-guard + packing tests; golden-audio fixture.
3. **Analysis — Stage 3** — new skill/prompt/runStage3, strict envelope, multilingual split,
   analysis-form + emotion-button wiring, Stage-3 vocalization flag.
4. **Guardrails** — Script-Review round-trip regression; srv-31 marker-driven carve-out.

(Waves are an ordering aid; delivered per the project's branch/PR conventions. **Closes #997.**)
