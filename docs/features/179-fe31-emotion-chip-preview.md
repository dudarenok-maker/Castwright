---
status: active
shipped: null
owner: null
---

# fe-31 — Preview an emotion from the manuscript quote chip

> Status: active
> Key files: `src/components/sentence-emotion-control.tsx`, `src/lib/play-emotion-variant.ts`, `src/views/manuscript.tsx`
> URL surface: `#/books/<id>/manuscript`
> OpenAPI ops: none (reuses `GET /api/voices/:id/sample` via `playSampleWithAutoLoad`)

## Benefit / Rationale

- **User:** the per-quote emotion chip (fs-25) becomes auditionable in place — tag a line `angry`/`whisper`/`excited`/`sad`, hit ▶, and hear the character's designed variant without leaving the manuscript or opening the cast drawer. Also surfaces fs-25's missing-variant state (5e): a Qwen speaker without a variant for that emotion previews the BASE voice with an inline "renders neutral" note, and a non-Qwen speaker shows the preview disabled with an "Emotion only audible on Qwen" tooltip.
- **Technical:** reuses the existing variant cache scope (`${baseScope}__${emotion}`) so a warm sidecar is a cache hit (no re-synth); the single-in-flight gate lives in `playSampleWithAutoLoad`. No new endpoint, no synth-schema change.
- **Architectural:** keeps `SentenceEmotionControl`'s existing API working — the `character` prop is additive. The variant-vs-base resolution + base fallback is factored into `lib/play-emotion-variant.ts`, a pure-ish helper testable without the DOM audio singleton.

## Architectural impact

- **New seam:** `playEmotionVariantSample(character, emotion, playback)` (`src/lib/play-emotion-variant.ts`) builds the subject `Voice` + sample args and reports `fellBackToBase`. `variantVoiceIdFor(character, emotion)` reads `character.overrideTtsVoices.qwen.variants?.[emotion]?.name`.
- **Engine resolution:** the chip reads `character.ttsEngine === 'qwen'` — the same per-character engine signal `resolveDisplayTtsVoice` / the generation route use. Non-Qwen disables the preview (the tag is inaudible on Kokoro/XTTS).
- **Invariant preserved:** emotion is a Qwen-only audible lever (fs-25 / plan 177). A non-Qwen book is unaffected — the preview is disabled, never fired. No grouping/synth change (one-group-per-sentence already, plan 70d).
- **Reversibility:** drop the `character` prop from the `SentenceEmotionControl` call site in `manuscript.tsx` and the preview affordance disappears; the chip's tag/clear behaviour is untouched.

## Invariants to preserve

- `SentenceEmotionControl` still dispatches `manuscript/setSentenceEmotion` on menu pick and renders the chip tint from `EMOTION_CLASS` (`src/components/sentence-emotion-control.tsx`).
- Variant cache scope is `${sampleScopeFor(character)}__${emotion}` (mirrors `emotion-variant-designer.tsx playVariant`); the base-fallback scope is `sampleScopeFor(character)` with no suffix.
- The Qwen sample model key is `QWEN_MODEL_KEY` (`src/lib/tts-voice-mapping.ts`).

## Test plan

### Automated coverage

- Vitest unit (`src/lib/play-emotion-variant.test.ts`) — variant present → variant scope + variant voiceId; variant absent → base scope + base voice + `fellBackToBase:true`; `variantVoiceIdFor` reads the qwen variants map.
- Vitest unit (`src/components/sentence-emotion-control.test.tsx`) — Qwen speaker with variant previews (calls the helper, no note); Qwen speaker without variant shows the "renders neutral" note; non-Qwen disables the button with the Qwen-only tooltip; no character → no preview affordance.
- Playwright e2e (`e2e/manuscript-emotion-preview.spec.ts`) — in the manuscript view (mock mode), seed a Qwen speaker + variant, tag a sentence, hit ▶, assert the sample `play()` path fires and no error note surfaces.

### Manual acceptance walkthrough

1. **Mock mode**, open `#/books/<id>/manuscript` → tag a dialogue line `angry` via the chip → a ▶ preview appears next to the chip.
2. Flip the speaking character to Qwen with an `angry` variant (cast view) → ▶ enabled; click → the designed variant auditions.
3. Remove the `angry` variant → click ▶ → the base voice plays and a "no angry variant for <name> — renders neutral" note shows.
4. Switch the character to Kokoro → ▶ is disabled, tooltip "Emotion only audible on Qwen".

**Live GPU acceptance owed:** the audible difference between a designed variant and the base voice can only be confirmed on a real sidecar (CI has no sidecar venv). Mock mode proves the wiring + cache-scope selection only.

## Out of scope

- Designing variants (that's fs-25 / plan 177's `EmotionVariantDesigner` in the cast/drawer surface).
- Analyzer-emitted emotion tags (fs-25 Phase-1).

## Ship notes

(Filled in when status flips to `stable`.)
