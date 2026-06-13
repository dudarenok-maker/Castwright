---
status: active
shipped: null
owner: null
---

# Plan 70d — Per-sentence synth groups + audio-tag stripping

> Status: active
> Key files: `server/src/tts/synthesise-chapter.ts`, `server/src/tts/text-normalize.ts`, `server/src/parsers/audio-tags.ts`
> URL surface: none — server-only behaviour change
> OpenAPI ops: unchanged

## Benefit / Rationale

- **User:** Three observable failures on the canonical Keeper book disappear in one fix:
  1. **Long all-narrator chapters never finish.** Chapter 4 of The Floodmark is a structured registry file — 207 narrator-only sentences. The old `buildSentenceGroups` folded consecutive same-speaker sentences into one synth call. Kokoro received one giant text blob, took longer than the 30 s "Worker has gone quiet" client watchdog, then either timed out or hung at very large context sizes. 200 s of patient waiting yielded zero `chapter_complete` ticks. Per-sentence groups cap each synth call at a single sentence — bounded duration, continuous progress feedback.
  2. **Bracket-marked audio tags are read aloud.** The analyzer emits inline tags like `[empathic]` / `[whispers]` (vocabulary in `server/src/parsers/audio-tags.ts`). No current TTS engine in this app interprets bracket markup as prosody — Kokoro v1, Coqui XTTS v2 and Gemini TTS all read it literally ("open bracket empathic close bracket"). User report: chapter 1 of The Floodmark played the tag string instead of inflecting the line. The fix strips the closed-vocabulary tokens at the TTS boundary in `normaliseForTts`; the original `sentence.text` is untouched so the UI caption / manuscript diff still sees the analyst's intent.
  3. **Voice drift mid-chapter.** Folding 200+ sentences into one call pushed Kokoro into its context-size pressure zone, where prosody / pronunciation shifts mid-chunk. Per-sentence calls keep each Kokoro context small and stable.
- **Technical:** The 30 s "Worker has gone quiet" watchdog (plan 31) assumes each synth call lands a tick within 30 s. Per-sentence groups make that contract trivially true at Kokoro's ~0.3–1 s / sentence pace. The folding optimisation it replaced was a "save HTTP roundtrips" play that didn't survive contact with large books; the per-sentence overhead (~5 ms / call HTTP framing on localhost) is dwarfed by the per-call compute, and small contexts often compute *faster* than one big context.
- **Architectural:** Closed-vocabulary tag stripping is an additive transform inside `normaliseForTts` — no API surface change, no schema change. The analyzer's tag-emission path is unaffected; downstream interpretation (e.g. a future Gemini natural-language style prefix derived from the tag) is a separate plan.

## Architectural impact

- **`buildSentenceGroups` (`server/src/tts/synthesise-chapter.ts`):** Was a same-speaker fold; now `sentences.map((s, i) => ({ index: i, characterId: s.characterId, sentenceIds: [s.id], text: s.text }))`. One group per sentence, regardless of speaker. Order preserved. Consumers (segments.json, SSE ticks, `onGroupStart` / `onGroupComplete` callbacks) operate unchanged — they now just fire more often.
- **`normaliseForTts` (`server/src/tts/text-normalize.ts`):** Gains `stripAudioTags` as the final step. The regex matches only the closed `AUDIO_TAGS` vocabulary (`emphatic | shouting | whispers | laughs | sighs | excited | hesitant`) wrapped in brackets, case-insensitive. Whitespace where the tag used to sit is collapsed so we don't produce doubled spaces.
- **Invariants preserved.**
  - `SentenceOutput` shape unchanged. The strip is applied to the text handed to the provider, never to the on-disk sentence ledger.
  - Per-engine voice routing (`pickVoiceForEngine` + `overrideTtsVoices.{engine}.name`) is untouched.
  - Sample-rate anchoring on the first group still works — first group is now first sentence, same contract.
  - Segments.json now carries one segment per sentence rather than one per same-speaker run. The Listen view's caption-by-segment logic handles this — segments are searched by playhead, granularity doesn't matter.
- **Migration story.** None. The next generation run picks up the new shape; previously rendered audio on disk is unaffected. No cache invalidation needed.
- **Reversibility.** Two-file diff. Revert is a single `git revert`.

## Invariants to preserve

1. `buildSentenceGroups(sentences).length === sentences.length` for any input. Cited in `synthesise-chapter.test.ts:plan 70d > emits one group per sentence`.
2. `normaliseForTts` strips `[knowntag]` even when surrounded by leading / trailing punctuation, but leaves arbitrary bracketed prose like `[Citation Needed]` untouched. Closed-vocabulary check is load-bearing.
3. `normaliseForTts` is idempotent on tag stripping: running it twice produces the same output as running it once.
4. Audio-tag vocabulary lives in one place: `server/src/parsers/audio-tags.ts:AUDIO_TAGS`. The TTS normaliser imports from there rather than maintaining a duplicate list.

## Test plan

### Automated coverage

- `server/src/tts/text-normalize.test.ts`:
  - `strips the analyzer vocabulary tags so Kokoro / Coqui do not read them aloud` — happy path on the seven AUDIO_TAGS values.
  - `preserves arbitrary bracketed prose that is NOT in the audio-tag vocabulary` — closed-vocabulary invariant.
  - `collapses the whitespace where a tag used to sit` — no doubled spaces after a tag removal.
  - `is idempotent on tag stripping (no leftover brackets on second pass)`.
- `server/src/tts/synthesise-chapter.test.ts`:
  - `buildSentenceGroups (plan 70d — per-sentence) > emits one group per sentence even when consecutive sentences share a speaker`.
  - `… > preserves order across mixed speakers`.
  - `… > scales to a 207-sentence all-narrator chapter (the regression case)`.
  - `scrubs all-caps openers and em-dashes before handing text to the provider` — updated to assert per-call (3 calls instead of 1) so the new contract is pinned end-to-end.

### Manual acceptance walkthrough

1. With The Floodmark open in the Generate view and chapters 1-3 already rendered, click Generate.
2. **Expected:** Chapter 4 starts; the UI's "line N of 207" caption advances continuously (every sentence) rather than sitting on `1 of 207` for the whole call. No "Worker has gone quiet" banner.
3. Audit chapter 1's MP3 (or any chapter containing an `[empathic]` / `[whispers]` analyst tag): the bracket characters are NOT spoken aloud. The line is delivered as plain prose.
4. (Optional) On a chapter the analyzer tagged heavily (multiple `[laughs]` / `[sighs]`), confirm pronunciation stability across the chapter — no mid-chapter prosody drift.

## Out of scope

- **Re-purposing the tag intent.** The analyzer's `[empathic]` decision is currently dropped at the TTS boundary. A follow-up plan can use it to (a) prefix Gemini synth with a natural-language style hint, (b) switch Kokoro `voice` slot to a softer variant per-sentence, (c) wrap Coqui synth in a per-sentence emotional preset. Filed as BACKLOG.
- **Group-by-character batching for engines that prefer it.** Future engines may want batched payloads. If that becomes a real constraint, expose a per-engine "max-sentences-per-call" knob on `buildSentenceGroups`. Today's set (Kokoro, Coqui, Gemini) all benefit from per-sentence.
- **Frontend caption changes.** Listen view consumes segments.json the same way regardless of granularity; no UI change required.

## Ship notes

(filled at merge)
