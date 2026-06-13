---
status: stable
shipped: 2026-05-27
owner: null
---

# Qwen voice presentation — status-first Voices view + cast Status pill

> Status: stable (shipped across two PRs — server data layer, then frontend)
> Key files: `server/src/routes/voices.ts`, `server/src/audio/segments-io.ts`, `src/views/voices.tsx`, `src/views/cast.tsx`, `src/mocks/voices.ts`
> URL surface: `#/voices` (cross-book) and `#/books/<id>/cast`
> OpenAPI ops: `GET /api/voices` (adds `Voice.generated`)

## Benefit / Rationale

The cross-book Voices view groups cast members into voice **families** keyed by
`(ttsVoice.provider, ttsVoice.name)`. That fits preset engines (kokoro/coqui/gemini/piper)
where many characters share one base voice. But **Qwen is a bespoke per-character engine**
(plan 108): each character gets a *unique* designed voiceId `qwen-{voiceId ?? characterId}`, so
every designed Qwen voice forms a degenerate **1-member family** — a section-per-character
cascade, each repeating the full family chrome. Undesigned Qwen characters collapse into one
empty-name `qwen|` family.

- **User:** Qwen voices read status-first — `Qwen · Needs a voice` (no designed voiceId) and
  `Qwen · Designed voices` (with a per-card **Designed**/**Generated** badge) — so it is
  obvious which cast still need work. The cast Status column stops showing a false green
  "Generated" pill for a Qwen character that has no designed voice.
- **Technical:** a single server-computed `Voice.generated` flag (per-voiceId, sourced from
  rendered segments) drives both surfaces. The Voices view derives the `none`/`designed` split
  client-side from `ttsVoice.name`; `generated` upgrades the badge.
- **Architectural:** preset voice-family grouping is untouched; Qwen gets a parallel
  status-bucket builder. The `voiceState` provenance enum is NOT repurposed — the collision
  ("generated" provenance vs "generated" = rendered) is resolved at the presentation layer.

## Architectural impact

- **New seam:** `server/src/audio/segments-io.ts` — shared reader for `<slug>.segments.json`
  (`loadSegmentsFiles` + `collectRenderedQwenVoiceNames`). `routes/revisions.ts` now imports it
  (its private copy was deleted); `routes/voices.ts` uses `collectRenderedQwenVoiceNames` to
  stamp `generated`.
- **Contract change:** `openapi.yaml` `Voice` schema gains optional `generated: boolean`
  (regenerated into `src/lib/api-types.ts`). Additive — old clients ignore it.
- **Invariants preserved:** OpenAPI remains the type source of truth (field added there,
  regenerated, never hand-edited). Preset aggregation path is byte-for-byte unchanged — the
  segments scan runs only for the `engine=qwen` query.
- **Migration story:** none. `generated` is derived at read time from existing on-disk
  segments; pre-existing voices simply read falsy until their book renders.
- **Reversibility:** drop the field + the Qwen branch in `buildQwenStatusGroups`; the preset
  path is independent.

## Invariants to preserve

- `aggregateVoices` (`server/src/routes/voices.ts`) only scans segments when the engine query
  is `'qwen'`; preset queries emit no `generated`.
- `generated` is OR-aggregated across every book sharing a voiceId (rendered anywhere ⇒ true).
- A Qwen voice with no designed voiceId resolves to `ttsVoice.name === ''`
  (`server/src/tts/voice-mapping.ts` qwen branch) and never carries `generated`.
- Voices view: Qwen renders as exactly **two** sections (Needs a voice / Designed voices), not
  one-per-voice. Preset engines keep `(provider, name)` family grouping.
- Cast Status column: Qwen rows resolve their pill from the lifecycle (Needs voice / Designed /
  Generated), ignoring `voiceState`; preset rows keep `voiceState` pills.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/voices.test.ts`, `describe('GET /api/voices?engine=qwen — generated flag')`) — a designed Qwen voice appearing in a rendered snapshot gets `generated:true`; a designed-but-unrendered voice does not; an undesigned voice (`ttsVoice.name===''`) never does; the `engine=coqui` query emits no `generated` (preset path untouched). **[landed — server PR]**
- Vitest server (`server/src/routes/revisions.test.ts`) — drift detector stays green after the `loadSegmentsFiles` extraction (31 tests). **[landed — server PR]**
- Vitest unit (`src/views/voices.test.tsx`, `describe('LibraryView Qwen status sections (plan 117)')`) — exactly two Qwen regions by `aria-label` (not one per voice); none → "Needs a voice", designed → "Designed voices"; Designed/Generated badge; no "Audition base voice" on Qwen headers; per-series Rebaseline present; Qwen-only library doesn't show the empty state; preset family tests unchanged. **[landed — frontend PR]**
- Vitest unit (`src/views/cast.test.tsx`, `describe('CastView Qwen status pill (plan 117)')`) — Qwen no-voice → "Needs voice" (not green "Generated"); designed → "Designed"; matched library voice `generated:true` → "Generated"; preset provenance pills (Generated/Reused) unchanged; defensive when `library` is empty. The existing `cast-slice.test.ts` "defaults missing voiceState to 'generated'" test pins that the provenance enum default is untouched. **[landed — frontend PR]**
- Playwright e2e (`e2e/voices-qwen-status.spec.ts`) — the two Qwen sections + Designed/Generated badges render alongside a preset family on `#/voices`; no "Audition base voice" on a Qwen section. **[landed — frontend PR]**

### Manual acceptance walkthrough

1. **`#/voices`** (mock mode) → preset voices still grouped by family; Qwen renders as
   `Qwen · Needs a voice` + `Qwen · Designed voices`; no per-Qwen-voice cascade, no ⚠ pill or
   "Audition base voice" on Qwen sections; per-series Rebaseline present.
2. A designed Qwen card shows a **Designed** badge; one whose book has rendered shows
   **Generated**.
3. **`#/books/<id>/cast`** → a Qwen character with no designed voice shows **Needs voice** (not
   green Generated); designed shows **Designed**; a rendered one shows **Generated**. Preset
   characters keep their `voiceState` pills.

## Out of scope

- Renaming the `voiceState` enum (collision resolved at presentation only).
- Per-book (vs cross-book) `generated` precision in the cast table — accepted simplification:
  `Voice.generated` is "rendered in any book carrying this voiceId".
- Cross-series voice linking (`srv-7`), bulk duplicate review (`fe-9`).

## Ship notes

Shipped 2026-05-27 across two PRs:

- **#272** (`9f1495b`) — data layer. Added optional `Voice.generated` to the OpenAPI `Voice` schema; `aggregateVoices` (`server/src/routes/voices.ts`) stamps it for the `engine=qwen` query by scanning rendered chapter segments (`voiceEngine === 'qwen'` + `resolvedVoiceName`). Extracted the shared segments reader into `server/src/audio/segments-io.ts` (`loadSegmentsFiles` + new `collectRenderedQwenVoiceNames`); `routes/revisions.ts` now imports it. Per-character precise (not coarse book-level), OR-aggregated across books sharing a voiceId. Preset path untouched (scan runs only for `engine=qwen`).
- **#274** (`fd70983`) — frontend. Partitioned Qwen out of `buildFamilies` into `buildQwenStatusGroups` (two sections: "Needs a voice" / "Designed voices", the latter badged Designed/Generated off `Voice.generated`); shared `nestBySeriesBook` helper; new `QwenStatusSection`; optional `badge` prop on `VoiceCard`. Dropped "Audition base voice" + ⚠ duplicate pill for Qwen, kept per-series Rebaseline. Cast view gained an engine-aware `StatusPill` (Needs voice / Designed / Generated for Qwen rows; preset rows keep `voiceState` pills). The `voiceState` enum was NOT repurposed — collision resolved at the presentation layer.

Deltas vs. the original spec: none material. The chosen UX was "two sections + per-card Designed/Generated badge" (not three top sections) and per-character precise `generated`, both confirmed with the user before build.

## Amendment (2026-05-27) — preset pill relabel "Generated" → "Matched"

The preset (`voiceState`) Status pill for `voiceState: 'generated'` was relabeled from **Generated** to **Matched** (`resolveStatusPill`, `src/views/cast.tsx`). Rationale: in the provenance enum, `'generated'` means "voice auto-matched/assigned during analysis" — not "audio rendered" — so "Matched" reads accurately and removes the wording collision with the Qwen-lifecycle **Generated** pill (which genuinely means rendered audio and is unchanged). Only the preset path changed; the Qwen lifecycle (Needs voice / Designed / Generated) is untouched. The `cast.test.tsx` "keeps the preset provenance pills" case now asserts **Matched**.

Known simplification (carried as designed): `Voice.generated` is populated only when the library is fetched with `engine=qwen` — i.e. when the project is on Qwen, which is also the only time Qwen sections/rows appear. Mixed-engine setups conservatively render "Designed". No BACKLOG follow-up filed; revisit only if cross-book over-report proves confusing in practice.

### Post-ship fix — `fix/frontend-voices-rehydrate-on-generation` (Status pill stayed "Designed" after a voice was generated)

- **The cast Status pill (and the Voices view's Designed/Generated split) now flip live as chapters render, instead of only on book/engine/stage change.** The `generated` flag is server-derived from rendered segments, but the voice library only re-hydrated when `bookId` / `stageKind` / `ttsEngine` changed (`src/components/layout.tsx`). So generating a chapter while sitting on the cast view left the on-disk `generated:true` invisible — e.g. "Wren was generated, still showing Designed" — until the user navigated away and back. Fix: the hydrate effect now also keys off `genProgress` = the sum of the completed-chapter (`done`) count across **all** active generation streams (`s.chapters.activeStreams`), so every rendered chapter — in any book, honouring the concurrent-multibook invariant — triggers a `getVoices` refetch, and the count drops as streams clear on completion. One extra `getVoices` per completed chapter while the app is mounted; the server scan is the existing read-time derivation, no new endpoint.
- Tests: `src/components/layout.test.tsx` (+1 — advancing an active stream's `done` count via `setActiveStream` then `updateActiveStreamProgress` re-fires `api.getVoices` each time, on top of the mount fetch). typecheck + lint clean.

## Amendment (2026-05-28) — new "Sampled" lifecycle tier between Designed and Generated

The Qwen lifecycle gained a fourth state. Previously a designed Qwen voice stayed **Designed** until a *chapter* rendered, at which point it flipped to **Generated** — so synthesising a 12s audition (the "Play 12s" button) produced audio the Status pill never acknowledged ("designed a voice, sampled it, still reads Designed"). The ladder is now **Needs voice → Designed → Sampled → Generated**, where **Sampled** = "a 12s audition has been synthesised" and **Generated** = "a chapter has rendered" (unchanged). `generated` outranks `sampled` at the presentation layer.

- **Server:** a new optional `Voice.sampled` flag (OpenAPI `Voice` schema; mirrors `generated`). `aggregateVoices` (`server/src/routes/voices.ts`) stamps it for the `engine=qwen` query by checking the voice-sample cache (`listVoiceSampleFiles`, new in `server/src/tts/voice-sample-cache.ts`) for a `<scope>-qwen3-tts-0.6b-*.mp3` file, where `scope = voiceId ?? char-<characterId>` — the same scope the player + design route cache under (`sampleScopeFor`). Anchored on the single Qwen synth model key so a `wren` scope can't false-match a `wren-sparrow` file. Cross-book OR-aggregated like `generated`; preset path untouched (scan runs only for `engine=qwen`).
- **Frontend:** `resolveLifecyclePill` (`src/lib/voice-status.ts`) inserts the **Sampled** tier (`peach` pill) between Generated and the Designed fallback — feeding the cast Status column AND the profile-drawer header via the shared resolver. The Voices view's own badge (`src/views/voices.tsx`) becomes three-way (Generated / Sampled / Designed).
- **Live flip:** the library only re-hydrates on book/stage/engine/`genProgress` change, none of which a sample triggers — so a new optimistic `voicesActions.markSampled` (`src/store/voices-slice.ts`, mirrors `setPinned`) fires after a successful Qwen audition in both `src/views/cast.tsx` and `src/modals/profile-drawer.tsx`. The next `GET /api/voices` confirms it from disk.
- Tests: server `voices.test.ts` (+3 — sampled-not-generated via a dropped cache file, no-file un-sampled, preset path emits no `sampled`); `voice-status.test.ts` (+3 — Sampled tier, generated-outranks-sampled, Needs-voice-ahead-of-stray-sample); `cast.test.tsx` (+2 — Sampled pill render, optimistic `markSampled` after a Qwen audition); `voices.test.tsx` (+1 — Sampled badge); `voices-slice.test.ts` (+2 — `markSampled`); e2e `voices-qwen-status.spec.ts` (Wren sampled fixture + badge). New mock fixture `v_wren` in `src/mocks/voices.ts`. typecheck clean.
