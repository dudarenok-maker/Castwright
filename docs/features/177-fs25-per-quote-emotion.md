---
status: draft
shipped: null
owner: null
---

# fs-25 — Per-quote expressive / emotion synthesis

> Status: draft — design approved, implementation staged in waves below.
> Key files: `openapi.yaml` (Sentence + Character.overrideTtsVoices), `server/src/handoff/schemas.ts`, `server/src/analyzer/` (Phase-1 attribution), `server/src/tts/synthesise-chapter.ts` + `server/src/tts/voice-mapping.ts` (voice resolution), `server/src/routes/qwen-voice.ts` (variant design), `src/views/manuscript.tsx`, `src/views/cast.tsx` / profile drawer.
> URL surface: `#/books/<id>/manuscript` (per-quote emotion picker), `#/books/<id>/cast` (design emotion variants).
> OpenAPI ops: reuses `POST /api/books/{bookId}/cast/{characterId}/design-voice` (adds optional `emotion`); no new synth op — `/synthesize` + `/synthesize-batch` contracts are unchanged.
> GitHub issue: [#479](https://github.com/dudarenok-maker/AudioBook-Generator/issues/479). Backlog id `fs-25`.

## Benefit / Rationale

- **User:** a step-change in narration expressiveness — a whispered aside, an angry shout, an excited reveal actually *sound* different, derived automatically by the analyzer and correctable per line. A differentiating capability.
- **Technical:** rides entirely on existing machinery — the analyzer already emits per-sentence attribution; the Qwen design flow already mints bespoke voices; synthesis is already one-group-per-sentence so per-quote voice selection needs **no** grouping change. The synth wire contract is untouched.
- **Architectural:** locks in the rule that **expressive control on Qwen is a *voice-selection* concern, not a synth-parameter concern** — emotion picks a pre-designed variant voiceId, so the sidecar `/synthesize` contract stays minimal and Kokoro/XTTS are provably unaffected.

## The Qwen constraint that shapes the whole design

Qwen's resident **Base** synth model (`generate_voice_clone(text, language, voice_clone_prompt)`, `server/tts-sidecar/main.py:1448` single / `:1527` batch) takes **no** per-utterance emotion/instruct argument. Expressiveness is baked into a voice's cached clone-prompt embedding at **design** time, via the heavy 1.7B VoiceDesign model (`generate_voice_design(text, language, instruct=…)`, `main.py:1325`). Therefore a per-quote emotion **cannot** be a string passed at synth time. The only architecturally-sound lever is **selecting a different pre-designed voice prompt per quote**.

So an emotion variant = an independently designed voiceId (its own `.pt` + manifest in the shared voice library), produced by the **existing** design flow with an emotion-augmented `instruct` (persona + "spoken angrily/whispered/…"). At generation, a quote's emotion tag selects that variant voiceId; absence selects the character's base (neutral) voice. **Kokoro/XTTS have no expressive control at all** and never read the emotion — the tag is a strict no-op for them.

## Emotion taxonomy (fixed enum)

`neutral | whisper | angry | excited | sad`. `neutral` (and any untagged sentence) renders **exactly as today** on every engine. Bounded to 4 expressive values to cap variant-design cost (≤4 extra designs per character). The enum lives in one place (`openapi.yaml` → regenerated `api-types.ts`) and is mirrored in the Zod schema + the analyzer skill prompt. Widening later is additive (a new enum value + optionally a new variant); narrowing is a migration.

## Architectural impact

**New seams / extension points**
- `Sentence.emotion?: <enum>` — optional, additive. Absent = `neutral`.
- `Character.overrideTtsVoices.qwen.variants?: { [emotion]: { name } }` — additive sub-map of designed variant voiceIds, keyed by emotion. The base `name` stays the neutral voice. (The `overrideTtsVoices` object's inner schema has no `additionalProperties: false`, so adding `variants` is schema-compatible.)
- `design-voice` route gains optional `emotion` → augments the instruct and writes to the variant voiceId slot.
- Voice resolution gains a single Qwen-gated branch: `engine === 'qwen' && variants?.[emotion] ? variant : base`.

**Invariants preserved**
- **Sidecar synth contract unchanged** — `/synthesize` + `/synthesize-batch` request bodies are byte-identical; Kokoro/XTTS/Qwen-Base `synthesize(model, voice, text)` signatures untouched. (Cross-cutting plan 24/26 — engine abstraction.)
- **One-group-per-sentence** (`buildSentenceGroups`, `synthesise-chapter.ts:452`) is preserved — emotion changes *which voice* a group resolves to, never *how* groups are built. No fold/split change.
- **Never-cross-language** (fs-2) — variant design inherits the character's language; an emotion variant is the same language as its base.
- **Reused-voice resolution** (`hydrate-reused-voice.ts`) — variants resolve through the same `overrideTtsVoices.qwen` path; a reused base voice with no variants simply falls back to base (no regression).

**Migration story**
- Old sentences without `emotion` → read as `neutral` (no migration needed; optional field).
- Old casts without `variants` → the qwen slot is `{ name }` only; resolution falls back to base for every emotion. Lazy — no rewrite. The existing `overrideTtsVoice`→`overrideTtsVoices` normaliser is untouched.

**Reversibility**
- Feature is inert until (a) a sentence carries a non-neutral `emotion` AND (b) a matching variant has been designed. Removing the analyzer emotion output + hiding the UI affordances reverts to today's behaviour with no data cleanup required (variant `.pt` files are just extra library voices).

## Invariants to preserve

1. `buildSentenceGroups` (`server/src/tts/synthesise-chapter.ts:452`) stays one-group-per-sentence; FS-25 must not reintroduce folding.
2. The sidecar `/synthesize` request body is exactly `{ engine, model, voice, text }` (`server/tts-sidecar/main.py:2631-2634`) and `/synthesize-batch` items are exactly `{ voice, text }` (`main.py:2775` + `server/src/tts/sidecar.ts:132`). FS-25 adds **no** field here.
3. Voice resolution for non-Qwen engines must not read `emotion` — the emotion branch is gated `engine === 'qwen'`. An all-neutral chapter (or any Kokoro/XTTS chapter) must produce byte-identical synth calls to pre-FS-25 (regression-pinned).
4. `Sentence` required fields stay `[id, chapterId, text, characterId]` (`openapi.yaml` ~3883); `emotion` is optional.
5. A quote tagged with an emotion that has **no** designed variant falls back to the base voice and never fails the chapter (loud-but-non-fatal, like the undesigned-voice path).

## Implementation waves

Each wave is its own commit on `feat/server-fs25-per-quote-emotion`; the branch is multi-scope. Land paired tests per wave.

**Wave 1 — data model (additive, back-compat).**
- `openapi.yaml`: add `Sentence.emotion` (enum) + `Character.overrideTtsVoices.<engine>.variants` (optional map). Regenerate `api-types.ts` (`npm run openapi:types`).
- `server/src/handoff/schemas.ts`: add optional `emotion` to `sentenceSchema` (mirrors the existing optional `confidence`, `:109`).
- Tests: `schemas.test.ts` — accepts a valid emotion, rejects an out-of-enum value, accepts absence; back-compat — old sentence/cast shapes still validate.

**Wave 2 — generation threading (the audible Qwen effect; Kokoro/XTTS no-op).**
- Carry `emotion` from `SentenceOutput` onto `SentenceGroup` (`synthesise-chapter.ts:209` add `emotion?`), populated in `buildSentenceGroups`.
- In voice resolution for a group (`voice-mapping.ts:pickVoiceForEngine` + its callers in `synthGroup`/`synthBatch`), add the Qwen-gated branch: `engine === 'qwen' && variants?.[group.emotion]?.name → variant; else base`. Non-Qwen path unchanged.
- Missing-variant fallback to base voice (no throw); surface via the existing fallback telemetry.
- Tests (server): an all-neutral chapter resolves identical voices to today on every engine (byte-identical synth-call regression); a Qwen chapter with a tagged sentence + a designed variant resolves the variant voiceId for that one item while neighbours keep the base; a tagged sentence with no variant falls back to base.

**Wave 3 — variant design (reuse the existing flow).**
- `server/src/routes/qwen-voice.ts` `design-voice`: optional `emotion` → derives the variant voiceId (e.g. `<baseVoiceId>__<emotion>`), augments `instruct` with the emotion descriptor, writes the variant `.pt`/manifest, and records `overrideTtsVoices.qwen.variants[emotion]` on the cast.
- Sidecar: **no change** — `design_voice(voice_id, instruct, …)` already handles an arbitrary voiceId + instruct.
- Tests: server route test (mock sidecar) — designing with `emotion=angry` writes the variant slot + an augmented instruct; pytest sidecar — a variant voiceId synthesises like any designed voice (and Kokoro/XTTS are untouched).

**Wave 4 — analyzer (optional emotion inference).**
- Add optional per-sentence `emotion` to the Phase-1 attribution schema + skill prompt (`skills/audiobook-sentence-attribution.md`) and both the gemini and manual parsers. Strictly optional; low confidence → omit (renders neutral). Gate behind the existing warm-up-window convention so early chapters aren't noisy.
- Tests: parse-and-repair accepts/ignores the field; an attribution payload with emotions round-trips into sentences.

**Wave 5 — UI.**
- Manuscript view (`src/views/manuscript.tsx`): a per-sentence emotion chip/menu on a quote (shows analyzer value, editable; neutral hidden/muted). Respects the 44px touch-target + `coarse-pointer` rules. Persists the override through the existing manuscript-edits store.
- Cast / profile drawer: a "design emotion variant" affordance per character (reuses the Qwen design flow + design-progress UI), showing which variants exist.
- Tests: Vitest — editing a quote's emotion dispatches the edit + persists; Playwright e2e — the per-quote picker round-trips in a real browser (manuscript surface).

## Test plan

### Automated coverage
- `server/src/handoff/schemas.test.ts` — `Sentence.emotion` enum validation + back-compat (Wave 1).
- `server/src/tts/synthesise-chapter.test.ts` — all-neutral chapter byte-identical voice resolution on every engine; Qwen variant selection per tagged sentence; missing-variant fallback (Wave 2). **This is the Kokoro/XTTS safety net.**
- `server/src/routes/qwen-voice.test.ts` — `design-voice` with `emotion` writes the variant slot + augmented instruct (Wave 3).
- `server/tts-sidecar/tests/test_synthesize.py` (+ a variant case) — a Qwen variant voiceId renders; Kokoro/XTTS unaffected (Wave 3).
- `server/src/analyzer/parse-and-repair.test.ts` — emotion field parse/ignore (Wave 4).
- `src/views/manuscript.test.tsx` + `e2e/` spec — per-quote emotion edit round-trip (Wave 5).

### Manual acceptance walkthrough (real sidecar, GPU — owed; CI has no sidecar venv)
1. Cast view → design an `angry` variant for one character → variant pill appears; cast.json gains `overrideTtsVoices.qwen.variants.angry`.
2. Manuscript view → tag one of that character's quotes `angry` (and leave a neighbouring quote neutral).
3. Generate the chapter on Qwen → the tagged line is audibly angrier; the neutral neighbour is unchanged; log shows the variant voiceId for the tagged item only.
4. Switch the same book to Kokoro (or XTTS) and regenerate → output is byte-for-byte what an untagged run produces (emotion ignored); no errors.
5. Tag a quote with an emotion that has **no** variant → generation completes, that line renders in the base voice, and the fallback is surfaced (not a failure).

## Out of scope
- Per-quote emotion on **Kokoro/XTTS** as audible output — they have no expressive lever; the tag is a documented no-op. (A future item could map emotion → speed/pacing for Kokoro, but that is not this plan.)
- Free-form / continuous emotion (intensity sliders). The enum is fixed; revisit only if the variant-design UX proves out.
- Auto-designing variants on demand at generation time (would reintroduce the ~10 RTF VoiceDesign cost mid-run). Variants are designed ahead of time, explicitly.
- Coordinate (do not duplicate) with `side-4`/`side-7` decode-cost wake-conditions — note that variants don't inflate per-call decode, but more distinct voices mean more `.pt` loads / VRAM churn.

## Ship notes

(Filled when status → `stable`: shipped date, commit SHA, behaviour delta vs spec, then `git mv` to `docs/features/archive/`.)
