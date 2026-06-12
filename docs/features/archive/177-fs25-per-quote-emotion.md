---
status: stable
shipped: 2026-06-04
owner: null
---

# fs-25 — Per-quote expressive / emotion synthesis

> Status: stable — core shipped via PR #505 (merge `87ddfdf`, 2026-06-04): waves 1–3, 4a, 5a–5d, 6a. Deferred sub-waves re-homed as their own backlog items on 2026-06-05: **4b** LLM emotion-backfill pass → `fs-33` (#510); **5e** remainder (remove-variant route, Voices-view badge, staleness-on-edit, cast-row missing-variant count) → `fs-34` (#511) — the manuscript missing-variant inline hint half of 5e shipped via `fe-31` (#506); **6b** rebaseline series variant-design → `fe-32` (#512). Live-GPU acceptance still owed. See "Ship notes" + "Delivery status" below.
>
> **fs-33 + fs-34 shipped 2026-06-07** (one branch `feat/fs-emotion-loop-fs33-fs34`, closes #510 + #511). **fs-33:** emotion-only analyzer pass (`emotionAnnotationSchema` + `skills/audiobook-emotion-annotation.md` + `runEmotionChapter` on the `Analyzer` interface / Gemini / Ollama / FallbackAnalyzer) behind a streaming `POST /api/books/:bookId/annotate-emotion` route (`server/src/routes/annotate-emotion.ts`); a "Detect emotions" trigger (`src/components/detect-emotions-button.tsx`) in the manuscript header. **Key correctness fix:** detected emotion reaches synth via the SAME path manual tags use — the route streams `{sentenceId, emotion}` and the frontend `manuscript-slice` `applyDetectedEmotions` reducer (fill-only-empty ⇒ manual always wins) persists to `manuscript-edits.json`, which `rebuildCacheFromEdits` feeds to synth (writing only the analysis cache would have been wiped out — locked by `server/src/store/emotion-synth-readpath.test.ts`). **fs-34:** `DELETE …/cast/:characterId/emotion-variant/:emotion` + per-variant Remove in `EmotionVariantDesigner`; `VariantsBadge` on cross-book Voices Qwen cards; a shared `src/lib/stale-chapters.ts` raising the existing `staleAudio` banner on emotion/variant edits (audible-gated); a "N tags need a variant" cast-row count (`usedEmotionsByCharacter` + `countMissingVariants`). Deferred to follow-ups: per-chapter Detect trigger, a "manual-clear sticks" sentinel, and the standalone "Has emotion variants" filter in the Voices view. (A deferred `ANALYZER=manual` detect-support item — #594 — was dropped when the manual analyzer was retired in 71b35a8.) Live-GPU acceptance owed.
> Key files: `openapi.yaml` (Sentence + Character.overrideTtsVoices), `server/src/handoff/schemas.ts`, `server/src/analyzer/` (Phase-1 attribution + emotion-annotation pass), `server/src/tts/synthesise-chapter.ts` + `server/src/tts/voice-mapping.ts` (voice resolution), `server/src/routes/qwen-voice.ts` (variant design), `server/src/tts/hydrate-reused-voice.ts` + `cast-link-prior.ts` + `series-reuse-link.ts` + `book-state.ts` (Wave 6a reuse-carry), `src/lib/voice-status.ts` (Variants badge/filter), `src/lib/play-sample-with-auto-load.ts` (variant-aware sample playback), `src/views/manuscript.tsx`, `src/views/cast.tsx`, `src/modals/profile-drawer.tsx` + `src/components/voice-preview-button.tsx` + `src/modals/{match-detail,compare-cast-modal,rebaseline-modal}.tsx` (sample-play surfaces; rebaseline = Wave 6b series-design).
> URL surface: `#/books/<id>/manuscript` (per-quote emotion picker), `#/books/<id>/cast` (design emotion variants).
> OpenAPI ops: reuses `POST /api/books/{bookId}/cast/{characterId}/design-voice` (adds optional `emotion`); adds `POST /api/books/{bookId}/annotate-emotion` (Wave 4b emotion-only backfill); no new synth op — `/synthesize` + `/synthesize-batch` contracts are unchanged.
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

## Reconciliation with the existing inline audio-tag system (supersede, don't conflict)

**Audio is LOCAL-ONLY** — Kokoro, Coqui/XTTS, and Qwen. Gemini is the *analyzer*, not a voice engine (Gemini TTS isn't free and isn't used); the `GeminiTtsProvider` in the tree is dormant for real books. So the engines that matter for FS-25 are exactly the three local ones, and emotion's audible lever is the Qwen variant (Kokoro/XTTS = no-op).

Prior per-quote work exists and must be reconciled, not duplicated. Parse-time heuristics inject inline bracketed cues into `sentence.text` — the `AUDIO_TAGS` vocabulary `emphatic | shouting | whispers | laughs | sighs | excited | hesitant` (`server/src/parsers/audio-tags.ts`, mirrored UI-side in `src/lib/audio-tags.ts`), rendered as chips in the manuscript (`src/views/manuscript.tsx:1544` via `splitAudioTagSpans`). **Every local engine strips them** via `normaliseForTts` before synthesis — so on the engines actually used they drive **zero generated audio**. They are purely a display/heuristic layer: "never fully used, just display."

Because they have no audio effect on local engines, the inline-tag system is **RETIRED** and fully replaced by `Sentence.emotion` — no audio-regression risk, one per-quote model:

1. **Taxonomy map (overlap):** `whispers → whisper`, `shouting → angry`, `excited → excited`. The other legacy tags (`emphatic`, `laughs`, `sighs`, `hesitant`) are paralinguistic / emphasis cues, NOT emotions — they do not enter the fixed emotion enum and are simply dropped (they drove no audio).
2. **Parse-time: seed `emotion`, stop injecting tags.** The parser heuristics that currently inject brackets (`tagShoutingDialog`/`tagExcitedDialog` etc. in epub/mobi/html/text/pdf) instead set `Sentence.emotion` for the mappable cases (all-caps-in-quotes → `angry`, `!` → `excited`) and drop the rest. No new `[tag]` is written into `sentence.text`.
3. **Existing books: one-time migration** (runs in the Wave 4b backfill / a `scripts/` migration): per cached sentence, extract any inline `[tag]` → seed `emotion` for the mappable ones, then **strip the brackets from the stored `text`** so no book renders a literal `[shouting]`. Manual/analyzer emotion still wins per the precedence rule.
4. **UI: emotion chip only.** Remove the legacy inline-tag chip rendering from the manuscript (`splitAudioTagSpans` at `manuscript.tsx:1544`) and delete the UI mirror `src/lib/audio-tags.ts`. The new emotion chip (5a) is the sole per-quote control.
5. **TTS boundary unchanged + safe.** `denormaliseAllCaps` (the all-caps→words fix, `text-normalize.ts:86`) is INDEPENDENT of the tag system and stays — retiring `[shouting]` does NOT regress shouted-caps reading. Keep `stripAudioTags` in `normaliseForTts` as a cheap defensive no-op for any un-migrated legacy text. The per-quote SIGNAL upgrades from "bracketed text every engine ignored" to "a structured field that drives a Qwen variant."

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
- **Reused-voice resolution** (`hydrate-reused-voice.ts`) — variants resolve through the same `overrideTtsVoices.qwen` path AND travel with the base voice across reuse links (Wave 6a, mirroring plan 150's `voiceStyle` denormalisation); a reused voice with no designed variants falls back to base (no regression).

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
6. **Neutral is the base voice, not a variant.** `overrideTtsVoices.qwen.name` = neutral base; `…qwen.variants` holds ONLY the 4 expressive emotions. Variant design is gated on the base existing — the cast UI hides/disables variant controls until `…qwen.name` is set.
7. **The "Variants" cast indicator is additive.** It is a new indicator derived in `src/lib/voice-status.ts`, placed under the Qwen voice label/section; it must NOT change `resolveVoiceStatus`'s lifecycle output (`Designed`/`Generated`/`Tuned`/`Locked`) or the `Reused` badge. Existing cast-status tests must stay green unchanged.
8. **Variant sample playback reuses the existing per-voiceId machinery.** A variant audition goes through `playSampleWithAutoLoad`/`playBaseVoiceSampleWithAutoLoad` keyed on the variant voiceId and the existing per-voiceId `voice-sample-cache.ts` — no new cache scheme, no new lifecycle path. Every current sample-play surface (cast, profile drawer + `voice-preview-button`, match-detail, compare-cast, rebaseline) must be able to audition a variant; none may diverge onto a private play path.
9. **Staleness reuses the existing `ui.staleAudio` path** (plan 114, `stale-audio-banner.tsx`). Emotion edits + variant (re)design feed it; FS-25 adds no parallel "needs regen" mechanism.
10. **All-caps→words TTS normalization (`denormaliseAllCaps`, `text-normalize.ts:86`) is independent of the retired tag system and MUST stay.** Retiring `[shouting]` injection touches only the tag path, never `denormaliseAllCaps`; shouted-caps must still read as words. A defensive `stripAudioTags` stays at the TTS boundary for un-migrated legacy text.

## Implementation waves

Each wave is its own commit on `feat/server-fs25-per-quote-emotion`; the branch is multi-scope. Land paired tests per wave.

**Wave 1 — data model + legacy-tag retirement (additive, back-compat).**
- `openapi.yaml`: add `Sentence.emotion` (enum) + `Character.overrideTtsVoices.<engine>.variants` (optional map). Regenerate `api-types.ts` (`npm run openapi:types`).
- `server/src/handoff/schemas.ts`: add optional `emotion` to `sentenceSchema` (mirrors the existing optional `confidence`, `:109`).
- **Retire the inline audio-tag system** (see Reconciliation): switch the parser heuristics (`server/src/parsers/audio-tags.ts` + its callers in epub/mobi/html/text/pdf) to set `Sentence.emotion` for the mappable cases instead of injecting `[tags]`, and drop the non-emotion injectors; remove the manuscript chip rendering + delete `src/lib/audio-tags.ts` (the manuscript chip removal lands with 5a). Keep `denormaliseAllCaps` + a defensive `stripAudioTags` in `text-normalize.ts`. Ship a one-time migration (`scripts/`, dry-run default + `--apply`, writes a `.bak`, idempotent — a re-run finds no brackets and no-ops, `BASE`/`CACHE_DIR` env overrides) that seeds `emotion` from existing inline tags and strips the brackets from cached `sentence.text`.
- Tests: `schemas.test.ts` — accepts a valid emotion, rejects an out-of-enum value, accepts absence; back-compat — old sentence/cast shapes still validate. Parser tests — the heuristic now sets `emotion` (shouting→angry, `!`→excited) and injects no bracket; `denormaliseAllCaps` still title-cases shouts at the TTS boundary. Migration test — a sentence with `[shouting]` in text → `emotion:'angry'` + clean text.

**Wave 2 — generation threading (the audible Qwen effect; Kokoro/XTTS no-op).**
- Carry `emotion` from `SentenceOutput` onto `SentenceGroup` (`synthesise-chapter.ts:209` add `emotion?`), populated in `buildSentenceGroups`.
- In voice resolution for a group (`voice-mapping.ts:pickVoiceForEngine` + its callers in `synthGroup`/`synthBatch`), add the Qwen-gated branch: `engine === 'qwen' && variants?.[group.emotion]?.name → variant; else base`. Non-Qwen path unchanged.
- Missing-variant fallback to base voice (no throw); surface via the existing fallback telemetry.
- Tests (server): an all-neutral chapter resolves identical voices to today on every engine (byte-identical synth-call regression); a Qwen chapter with a tagged sentence + a designed variant resolves the variant voiceId for that one item while neighbours keep the base; a tagged sentence with no variant falls back to base.

**Wave 3 — variant design (reuse the existing flow).**
- `server/src/routes/qwen-voice.ts` `design-voice`: optional `emotion` → derives the variant voiceId (e.g. `<baseVoiceId>__<emotion>`), augments `instruct` with the emotion descriptor, writes the variant `.pt`/manifest, and records `overrideTtsVoices.qwen.variants[emotion]` on the cast.
- Sidecar: **no change** — `design_voice(voice_id, instruct, …)` already handles an arbitrary voiceId + instruct.
- Tests: server route test (mock sidecar) — designing with `emotion=angry` writes the variant slot + an augmented instruct; pytest sidecar — a variant voiceId synthesises like any designed voice (and Kokoro/XTTS are untouched).

**Wave 4 — analyzer emotion inference (two paths; existing books get it WITHOUT a full re-analysis).**

Emotion is per-sentence, so a brand-new analysis can emit it inline — but **existing, already-analyzed books** (cached sentences predate FS-25) need a backfill. Build BOTH paths; the annotation pass is the default for existing books because a full re-analysis re-runs attribution (analyzer quota + risk of perturbing who-said-what / manual cast tweaks — the "verify re-analysis is actually needed" caution).

_4a — Phase-1 inline (covers new books + any re-analysis triggered for other reasons)._
- Add optional per-sentence `emotion` to the Phase-1 attribution schema + skill prompt (`skills/audiobook-sentence-attribution.md`) and both the gemini and manual parsers. Strictly optional; low confidence → omit (renders neutral). Gate behind the existing warm-up-window convention so early chapters aren't noisy. So a fresh analysis (or a reparse done for any reason) now carries emotion for free.

_4b — Emotion-only annotation pass (default backfill for existing books; non-destructive)._
- A new lightweight analyzer pass + skill (`audiobook-emotion-annotation`) that reads the book's already-attributed cached sentences and returns ONLY `{ sentenceId, emotion }` — it does **not** re-attribute, so `characterId`/cast/manual reassignments are untouched. New route (e.g. `POST /api/books/:bookId/annotate-emotion`, streaming progress like the analysis stream), cost surfaced up front (cf. `fs-27`). Writes emotion onto the cached sentences.
- **Seed already done in Wave 1:** the legacy-tag → `emotion` migration + parse-time seed (Reconciliation, Wave 1) already populated the mappable quotes, so the LLM annotation pass only needs to fill the still-`neutral` remainder — cheaper.
- **UI trigger (lands with Wave 5a, the manuscript surface where emotion chips live):** a **"Detect emotions"** action in the **manuscript view** header/toolbar (`src/views/manuscript.tsx`, `#/books/<id>/manuscript`). Click → a confirm that surfaces the cost estimate (sentence count + model) → runs the pass → inline streaming progress (reusing the analysis-stream progress pattern) → emotion chips populate when done. Scope defaults to the whole book with a per-chapter option (the view is already chapter-segmented). Re-runnable; respects manual-override precedence below (won't overwrite hand-set tags). An "Emotions detected / N untagged" hint sits beside the action so the user knows whether a backfill is worthwhile. This is the ONLY UI entry point for 4b — new books get emotion via 4a at analysis time and need no button.
- **Precedence (both paths):** a user's hand-set per-quote emotion (manuscript-edits) ALWAYS wins over analyzer-inferred emotion — annotation/re-analysis fills only sentences with no manual override, never clobbers a manual tag.
- Tests: `parse-and-repair` accepts/ignores the field (4a); the annotation pass returns emotion-only and leaves `characterId` untouched, and a sentence with a manual emotion override is not overwritten (4b); cost estimate surfaces before the run; (UI trigger test lands in Wave 5a).

**Wave 5 — UI.** (Split into 5a manuscript, 5b cast-design, 5c cast-indicator+filter so each lands with its own test.)

_5a — Manuscript per-quote tagging + the "Detect emotions" trigger._
- Manuscript view (`src/views/manuscript.tsx`): a per-sentence emotion chip/menu on a quote (shows analyzer value, editable; neutral hidden/muted). Respects the 44px touch-target + `coarse-pointer` rules. Persists the override through the existing manuscript-edits store. This emotion chip is the SOLE per-quote control: remove the legacy inline-tag chip rendering (`splitAudioTagSpans` at `manuscript.tsx:1544`) and delete `src/lib/audio-tags.ts` as part of this wave (the retirement seed/migration is Wave 1; see Reconciliation).
- The **"Detect emotions"** action (the Wave 4b trigger) lives in this view's header/toolbar: cost-confirm → run the annotation pass → inline streaming progress → chips populate; whole-book default + per-chapter option; an "N untagged" hint beside it. This is where existing books get bulk emotion without a re-analysis.
- Tests: editing a quote's emotion dispatches + persists; clicking "Detect emotions" confirms cost then streams + populates chips, and leaves manually-tagged quotes untouched.

_5b — Cast: design the variants (gated, all-or-some)._
- The variant-design affordance lives on the Qwen voice section of the cast row / profile drawer and is **gated on the neutral base voice existing** — i.e. `overrideTtsVoices.qwen.name` is present (the base voice has been designed). Until then the variant controls are hidden/disabled with a one-line "Design the main voice first" hint. **Neutral is never a "variant"** — it IS the base voice; the variant set is the 4 expressive emotions only.
- The UI must make it clear the user can design **all** variants or **just some**: a per-emotion control (each of `whisper`/`angry`/`excited`/`sad`) showing designed / not-designed / designing, with an individual "Design" action each, plus a "Design all remaining" convenience. Each variant is an independent design call (reuses the existing Qwen design flow + `ModelControlPill` / design-progress UI); designing one never blocks the others. Re-design overwrites that one variant's `.pt` AND evicts its stale cached sample (see Additional considerations).
- A designed variant writes `overrideTtsVoices.qwen.variants[emotion]` (Wave 3 route). Each variant row carries its own "play 12s" audition (see 5d).

_5d — Variant sample playback across ALL sample-play surfaces._
- A variant is just another designed voiceId, and the shared `playSampleWithAutoLoad` / `playBaseVoiceSampleWithAutoLoad` helpers (`src/lib/play-sample-with-auto-load.ts`) already resolve + auto-load a voiceId and cache the preview **per voiceId** (server `voice-sample-cache.ts`). So the single seam is making those helpers variant-aware (accept the variant voiceId); every surface that plays a sample then auditions a variant for free — no new cache scheme.
- Wire a variant audition control into **every** place a sample can be played today, so the surfaces don't drift:
  - Cast view rows — `src/views/cast.tsx` (`playSampleFor`).
  - Profile drawer — `src/modals/profile-drawer.tsx` (the main "Play 12s sample") AND the per-candidate `src/components/voice-preview-button.tsx`.
  - Match-detail modal — `src/modals/match-detail.tsx`.
  - Compare-cast modal — `src/modals/compare-cast-modal.tsx` ("Play 12s").
  - Rebaseline modal — `src/modals/rebaseline-modal.tsx` (`useSamplePlayback`).
- The cast surface + drawer expose a per-emotion play control (neutral base + each designed variant); a not-yet-designed variant shows no play control (nothing to audition). Auditions stay read-only (no cast commit), reusing `useTtsLifecycle` for the Load/Stop affordance exactly as today.

_5e — UI/UX completeness (cross-cutting gaps found in review)._
- **Audio staleness on edit.** Changing/adding a per-quote emotion, OR (re)designing a variant that existing tags reference, marks the affected chapters stale via the EXISTING `ui.staleAudio` banner (`src/components/stale-audio-banner.tsx`, set in `layout.tsx`'s save handler, plan 114) — keyed by character + chapterIds — so the user is prompted to regenerate the impacted chapters. No auto-regen; FS-25 adds no parallel staleness path.
- **Missing-variant discoverability (BEFORE generation).** When a quote is tagged with an emotion the speaker has no designed variant for, show a non-blocking hint at both edit sites: an inline marker on that quote in the manuscript ("no `angry` variant for Wren — renders neutral") and a small count on the cast row ("2 tags need a variant"). So the silent base-fallback (Wave 2) is discoverable up front, not only in post-run telemetry.
- **Qwen-only gating of the variant UI.** Variant design controls, the Variants badge, the filter chip, and per-variant play appear ONLY for Qwen-engine characters. On a non-Qwen (e.g. Kokoro) character the manuscript STILL lets you tag emotion (additive data that survives an engine switch) but shows a muted "applies on Qwen" note so the inaudibility on Kokoro/XTTS isn't a mystery.
- **Voices-view parity (free).** Because the badge + filter derive from the shared `src/lib/voice-status.ts`, the Variants badge and "Has emotion variants" filter also surface in the cross-book Voices view (`#/voices`, plan 117) with no extra wiring — same resolver, no divergence.
- **Remove a variant.** Each designed variant row carries a small remove affordance (drops `overrideTtsVoices.qwen.variants[emotion]` + its `.pt`), so a bad design is discardable without touching the base voice.
- **Responsive (mobile protocol, plan 81).** The per-emotion design grid + play controls collapse to a compact stacked list on phone (≥44px targets); the "Detect emotions" cost-confirm is a full-screen sheet on phone, dialog on tablet/desktop. Verify at all three viewports and add a `e2e/responsive/coverage.spec.ts` case.

_5c — Cast: indicator + filter (additive, must not disturb existing statuses)._
- Add a small **"Variants" badge** that is ADDITIVE and composes with — never replaces — the existing lifecycle pill (`Designed`/`Generated`/`Tuned`/`Locked`) and the `Reused` badge. It is a new indicator like `ReusedBadge` in *kind* (additive provenance/capability marker), but **placement-wise it sits under the Qwen voice label/section** (e.g. beneath the `qwen_wren` voice line), not crowded next to `Reused` — best use of screen space, final position settled during implementation. Source it from a new derived flag (e.g. `hasEmotionVariants` = `overrideTtsVoices.qwen.variants` has ≥1 key), computed in the shared resolver `src/lib/voice-status.ts` (the same place `resolveVoiceStatus` already splits provenance from lifecycle, plan 123) so cast view + drawer can't drift. The badge optionally shows the count (e.g. "Variants · 3") and/or which emotions on hover/tap.
- Add a cast **filter chip** for "Has emotion variants" to the plan-131 status-filter row: extend `statusFilterKeys` (`voice-status.ts`) so the chip appears (with a live count, like the others) only when ≥1 cast member has variants, and filters the post-search copy in both the desktop grid and mobile cards. Additive to the existing multi-select OR filter — never replaces a status chip.
- Both surfaces (cast view + profile drawer) read the same `hasEmotionVariants`/badge from `voice-status.ts` so they can't drift (same discipline as plan 123's shared resolver).

_Tests (Wave 5)._
- Vitest — editing a quote's emotion dispatches the edit + persists (5a); the variant-design controls are hidden/disabled until the base voice exists, and enabled after (5b); `resolveVoiceStatus`/`hasEmotionVariants` yields the Variants badge + the filter chip + count only when variants exist, and the badge composes with `Reused`/lifecycle without altering them (5c); a variant play control calls `playSampleWithAutoLoad` with the variant voiceId, and a not-yet-designed variant shows no play control (5d); an emotion edit on a rendered chapter raises the `ui.staleAudio` banner, a tag with no matching variant shows the missing-variant hint, variant UI is hidden for a non-Qwen character, and remove drops the variant slot (5e).
- Playwright e2e — the per-quote picker round-trips in a real browser (5a); the cast filter chip narrows the grid to variant-bearing characters (5c); a variant audition plays from the cast/drawer (5d); the variant grid + Detect-emotions confirm render correctly at phone/tablet/desktop via `e2e/responsive/coverage.spec.ts` (5e).

**Wave 6 — series propagation (variants travel across a book series).** Two facets, mirroring how base Qwen voices already propagate.

_6a — Reuse-linking carries variants (data)._ When a character's Qwen voice is reused across books, its `overrideTtsVoices.qwen.variants` must travel with the base, exactly as plan 150 made `voiceStyle` travel. Extend the shared resolver `server/src/tts/hydrate-reused-voice.ts` (`ReuseHydratable`/`ResolvedReusedVoice` gain `variants`; `hydrateCharacterVoice` carries `character… ?? resolved.variants`, own-wins) and the three reuse write sites that already denormalise the voice — `cast-link-prior.ts`, `series-reuse-link.ts`, `book-state.ts` (`PUT /state`). This corrects the earlier "reused base voice has no variants → falls back to base" note: a reused voice now keeps its designed variants series-wide. A reused character with no designed variants is still fine (empty map → base).

_6b — Rebaseline modal designs variants series-wide (UI)._ The plan-108 "Rebaseline the series" modal (`src/modals/rebaseline-modal.tsx`) — which designs bespoke base voices for the principal cast — gains an option to also design chosen emotion variants for those characters across the series, gated on each character's base existing (invariant 6), written as drift like the base rebaseline. Per-emotion selection (design all or some, reusing the Wave 5b controls' vocabulary); the existing audition/`useSamplePlayback` previews each (variant-aware via 5d). The base-voice rebaseline path stays intact when no variants are selected.

_Tests (Wave 6)._ Server — `hydrate-reused-voice` + the three write-site tests gain a case that a reused character carries its `variants` (own-wins over source); a reuse with no variants stays base. Frontend — the rebaseline modal offers per-emotion variant design gated on the base, and emits drift for each designed variant.

## Test plan

### Automated coverage
- `server/src/handoff/schemas.test.ts` — `Sentence.emotion` enum validation + back-compat (Wave 1).
- `server/src/tts/synthesise-chapter.test.ts` — all-neutral chapter byte-identical voice resolution on every engine; Qwen variant selection per tagged sentence; missing-variant fallback (Wave 2). **This is the Kokoro/XTTS safety net.**
- `server/src/routes/qwen-voice.test.ts` — `design-voice` with `emotion` writes the variant slot + augmented instruct (Wave 3).
- `server/tts-sidecar/tests/test_synthesize.py` (+ a variant case) — a Qwen variant voiceId renders; Kokoro/XTTS unaffected (Wave 3).
- `server/src/analyzer/parse-and-repair.test.ts` — Phase-1 emotion field parse/ignore (Wave 4a).
- annotation-pass route test — returns emotion-only, leaves `characterId` untouched, never overwrites a manual emotion override; cost estimate surfaces pre-run (Wave 4b).
- `src/views/manuscript.test.tsx` + `e2e/` spec — per-quote emotion edit round-trip (Wave 5).

### Manual acceptance walkthrough (real sidecar, GPU — owed; CI has no sidecar venv)
1. Cast view, a Qwen character whose **base voice is NOT yet designed** → the variant-design controls are hidden/disabled with a "Design the main voice first" hint; no "Variants" badge; the "Has emotion variants" filter chip is absent.
2. Design that character's **neutral base** voice → variant controls become enabled, showing all 4 emotions as "not designed" with individual Design buttons + a "Design all remaining" action.
3. Design **just** the `angry` variant (leave the others) → its control flips to "designed"; cast.json gains `overrideTtsVoices.qwen.variants.angry`; the character now shows the additive **"Variants" badge** under its Qwen voice label, with its existing lifecycle + any `Reused` badge unchanged; the "Has emotion variants" filter chip now appears with count 1 and narrows the grid to this character.
3a. **Play the `angry` variant's sample** from the cast row AND the profile drawer (and it's auditionable from the other sample surfaces too) → you hear the angry-voiced calibration line, distinct from the neutral base sample; the neutral base still plays its own sample; an undesigned variant offers no play control.
4. Manuscript view → click **"Detect emotions"** → cost-confirm → progress streams → emotion chips populate across the book (a previously hand-tagged quote is left untouched). Then manually tag one of that character's quotes `angry` (leave a neighbouring quote neutral) to confirm hand-edits override.
5. Generate the chapter on Qwen → the tagged line is audibly angrier; the neutral neighbour is unchanged; log shows the variant voiceId for the tagged item only.
6. Switch the same book to Kokoro (or XTTS) and regenerate → output is byte-for-byte what an untagged run produces (emotion ignored); no errors.
7. Tag a quote with an emotion that has **no** variant (e.g. `sad`) → BEFORE generating, the manuscript shows a "no `sad` variant — renders neutral" hint on that quote and the cast row shows a "needs a variant" count (5e missing-variant discoverability). Generate → that line renders in the base voice; the fallback is surfaced (not a failure).
8. With the chapter already rendered, change one quote's emotion (or remove/redesign a referenced variant) → the **stale-audio banner** appears for that chapter (5e), offering regeneration; no auto-regen fires.
9. On a non-Qwen (Kokoro) character → no variant-design controls / Variants badge / filter appear; the manuscript still lets you tag emotion but shows a muted "applies on Qwen" note. Resize to phone + tablet → the variant grid and Detect-emotions confirm stay usable (≥44px targets).

## Additional considerations (final-pass review)

Don't change the design, but must not be forgotten in implementation:

- **VRAM + design cost of N variants.** Each variant is minted on the heavy 1.7B VoiceDesign model (~RTF 10, VRAM-heavy). N emotions × principal cast — especially "Design all remaining" (5b) and series-wide rebaseline (6b) — multiplies VoiceDesign cycles, exactly what stresses the 8 GB GPU + host-RAM leak (plans 141/143/161). Reuse the EXISTING guards (VoiceDesign idle-watchdog frees the model between designs, recycle/leak ceilings, `_synth_lock` serialization); variant design must not run concurrently with a generation run on the same GPU (the analyzer/TTS eviction + GPU semaphore already arbitrate). At SYNTH time variants are cheap — a clone-prompt `.pt` is tiny, the Base model is shared, and mixing variant prompts in one batch adds no model load.
- **Sample-cache invalidation on re-design.** Re-designing a variant overwrites its `.pt`, so its cached 12 s sample (per-voiceId, `voice-sample-cache.ts`) goes stale. Re-design must refresh/evict that voiceId's cached sample exactly as the base design route already does, using the same `sampleScopeFor` stable-voiceId keying.
- **Where emotion persists + reparse survival.** Hand-set emotion rides `manuscript-edits.json` (survives reparse like speaker reassignments); analyzer/seed emotion rides the analysis-cache record (a full reparse re-derives it via 4a). Carry `emotion` in the `srv-13` reparse-preservation path so a reparse doesn't silently drop analyzer emotion between Phase-1 runs. Manual always wins.
- **a11y.** The emotion chip, per-emotion design controls, Variants badge, and the Detect-emotions action need aria-labels + keyboard operability; they land on the manuscript/cast core views the `test:a11y` axe gate covers — keep it green.
- **OpenAPI is the type source.** The `annotate-emotion` request/response, the `emotion` enum, and the `variants` map are defined in `openapi.yaml` and regenerated into `api-types.ts` — never hand-written.
- **Scope clarity:** emotion expressiveness lands on Qwen-voiced characters (usually dialogue). A narrator left on Kokoro stays neutral by design; switch the narrator to Qwen + design variants to express narration.

## Out of scope
- Per-quote emotion on **Kokoro/XTTS** as audible output — they have no expressive lever; the tag is a documented no-op. (A future item could map emotion → speed/pacing for Kokoro, but that is not this plan.)
- Free-form / continuous emotion (intensity sliders). The enum is fixed; revisit only if the variant-design UX proves out.
- Auto-designing variants on demand at generation time (would reintroduce the ~10 RTF VoiceDesign cost mid-run). Variants are designed ahead of time, explicitly.
- **Per-emotion intensity / multiple variants per emotion** (e.g. "slightly angry" vs "furious"). One variant per emotion key in v1.
- Coordinate (do not duplicate) with `side-4`/`side-7` decode-cost wake-conditions — note that variants don't inflate per-call decode, but more distinct voices mean more `.pt` loads / VRAM churn.

## Delivery status (2026-06-04, this PR)

**Implemented + tested:**
- **Wave 1** — `Sentence.emotion` + `overrideTtsVoices.qwen.variants` (openapi/Zod/types); legacy inline audio-tag system retired (`extractInlineEmotion` seed+strip at cache write, `scripts/migrate-emotion-from-tags.mjs`, manuscript chip + `src/lib/audio-tags.ts` removed, `denormaliseAllCaps` preserved).
- **Wave 2** — `pickEmotionVariantVoice` Qwen-gated resolution; strict no-op on Kokoro/XTTS; `SentenceGroup.emotion`.
- **Wave 3** — `design-voice` `emotion` → `<base>__<emotion>` + augmented instruct + persisted `variants[emotion]`.
- **Wave 4a** — attribution skill emits structured `emotion`.
- **Wave 5a** — manuscript per-quote emotion chip + edit (`setSentenceEmotion`, persisted, manual-wins).
- **Wave 5b** — cast `EmotionVariantDesigner` (gated on base, per-emotion + design-all, live redux update).
- **Wave 5c** — additive `VariantsBadge` + "Has emotion variants" cast filter via `voice-status.ts`.
- **Wave 6a** — emotion variants travel with a reused voice across a series (`hydrate-reused-voice`).

**Deferred to follow-ups (filed separately):**
- **4b** — emotion-only LLM annotation pass + `POST /annotate-emotion` + Detect-emotions trigger. (Covered for now by the migration seed, 4a, and manual tagging.)
- **5d — DONE on the design surface:** the cast variant designer auditions any designed variant (this or a prior session) via the shared `playSampleWithAutoLoad` (variant scope cache-hit). The other sample surfaces (compare-cast / match-detail / rebaseline) are base-voice comparison tools, intentionally left on base-voice playback — variant auditioning lives in the designer.
- **5e** — remove-variant (needs a server DELETE route), Voices-view badge render, staleness-on-edit + missing-variant pre-gen hint.
- **6b** — rebaseline modal series-wide variant design.

**Owed:** live GPU acceptance (CI has no sidecar venv) — design a variant, tag a quote, confirm audible-on-Qwen / byte-identical-on-Kokoro.

## Ship notes

- **Shipped:** 2026-06-04 via PR [#505](https://github.com/dudarenok-maker/AudioBook-Generator/pull/505), merge commit `87ddfdf`. Archived to `docs/features/archive/` on 2026-06-05.
- **Delivered (core):** waves 1–3, 4a, 5a–5d, 6a — the per-quote emotion data model (`Sentence.emotion`, `Character.overrideTtsVoices.qwen.variants`), Qwen-gated variant voice resolution (strict no-op on Kokoro/XTTS), emotion-augmented `design-voice`, Phase-1 analyzer emotion output, the manuscript per-quote chip, the cast `EmotionVariantDesigner` (+ audition), the additive `VariantsBadge` + filter, and series-reuse variant carry. Legacy inline audio-tag system retired (seed-and-strip migration; `denormaliseAllCaps` preserved).
- **Behaviour delta vs spec:** none of substance. 5d landed as "audition on the design surface" (the cast variant designer) rather than wiring variant playback into every sample surface — the compare-cast / match-detail / rebaseline surfaces are base-voice comparison tools and were intentionally left on base playback.
- **Deferred sub-waves re-homed (2026-06-05):** 4b → `fs-33` (#510); 5e remainder (remove-variant DELETE route + Voices-view badge render + staleness-on-edit + cast-row missing-variant count) → `fs-34` (#511); 6b → `fe-32` (#512). The manuscript missing-variant inline hint (part of 5e) shipped via `fe-31` (#506) in the same round as this archive.
- **Owed:** live-GPU acceptance (CI has no sidecar venv) — design a variant, tag a quote, confirm audible-on-Qwen and byte-identical-on-Kokoro (acceptance walkthrough steps 3a / 5 / 6 above).
