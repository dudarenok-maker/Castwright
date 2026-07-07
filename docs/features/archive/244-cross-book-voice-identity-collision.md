---
status: stable
shipped: 2026-07-07
owner: null
---

# Cross-book voice-identity collision (narrator / unknown-male / unknown-female)

> Status: stable
> Key files: `server/src/routes/voices.ts`, `src/lib/voice-character-link.ts`,
> `src/views/cast.tsx`, `src/views/voices.tsx`, `src/components/voice-library-panel.tsx`,
> `src/store/voices-slice.ts`, `src/store/voice-readiness-selectors.ts`,
> `src/modals/compare-cast-modal.tsx`, `src/modals/rebaseline-modal.tsx`, `src/modals/profile-drawer.tsx`
> URL surface: `#/books/<id>/cast`, `#/voices`
> OpenAPI ops: `GET /api/voices` (new `familyKey` field), `PUT /api/voices/:voiceId/pin`

## Benefit / Rationale

- **User:** a freshly-analysed, never-generated book's narrator / auto-folded
  background characters (`unknown-male`, `unknown-female`) no longer show a
  false **Generated** status, no longer get hidden from the voice library as
  "can't read \<language\>", and no longer play an unrelated book's cached
  sample audio when previewed.
- **Technical:** the workspace-wide voice aggregator can no longer silently
  merge two unrelated books' identity, pin state, or sample-cache lookups
  just because their auto-assigned character ids happen to coincide.
- **Architectural:** locks in a durable invariant — see "Invariants to
  preserve" below — that any future cross-book voice feature must respect:
  a bare `Character`/`Voice.id` is **not** a safe cross-book identity unless
  an explicit `voiceId` says so.

## Architectural impact

**Root cause.** The analyzer assigns a **fixed literal id** (`narrator`,
`unknown-male`, `unknown-female`) to every book's narrator and auto-folded
background-bucket character, and neither ever gets an explicit `voiceId`
(only a per-book `voiceUuid`, minted at design time — srv-43, plan 226).
`aggregateVoices()` in `server/src/routes/voices.ts` used to key its
workspace-wide fold on `id = character.voiceId ?? character.id` — the bare,
non-unique id — so two totally unrelated standalone books both landed in the
same aggregation bucket. Whichever book was enumerated first "won" the
shared `generated`/`languageCode`/`voiceUuid`/`pinned` fields for every other
book sharing that bare id.

**Fix, in two layers:**

1. **Server dedup key.** `aggregateVoices()` now computes a `dedupKey`
   (`voices.ts:306`: `c.voiceId ?? \`${state.bookId}::${id}\``) and uses it as
   the aggregation Map key instead of the bare `id`. An explicit `voiceId` is
   the ONLY signal that two characters in different books are *deliberately*
   the same voice (series continuity — e.g. Skulduggery Pleasant / Keeper of
   the Lost Cities intentionally share a literal `narrator` voiceId); without
   one, the key is book-scoped. The exposed `Voice.id` field is UNCHANGED
   (still bare `voiceId ?? id`), so same-book joins keep working. A new
   `familyKey` field (`voices.ts:418`, always `=== dedupKey`) is the
   globally-unique identity — use it for anything cross-book (React keys,
   multi-select, the pin endpoint); use `id` only for same-book joins.

2. **Client consumers**, several of which assumed `Voice.id` was unique and
   needed updating once the server started legitimately returning two
   same-id entries:
   - `findVoiceForCharacter` / `findCharacterForVoice`
     (`voice-character-link.ts:30`/`:55`) each take an opt-in boolean
     (`preferCurrentBook` / `restrictToCurrentBook`, default `false`) that
     prefers/restricts to a `source: 'current'` match. **Only pass `true`
     when the caller's character/roster is guaranteed to belong to the
     globally-open book** (cast.tsx, voice-library-panel.tsx,
     voice-readiness-selectors.ts). Compare-cast-modal.tsx and
     rebaseline-modal.tsx deliberately resolve a voice for an ARBITRARY
     OTHER book's character (a specific comparison/rebaseline side) and must
     stay at the default — passing `true` there would silently substitute
     the open book's own same-id voice for that side's real one.
   - `cast.tsx`'s drag-and-drop `findVoice`, the tap-to-assign
     toggle/highlight, and the sample-play `voiceUuid` injection
     (`cast.tsx:537`: `c.voiceUuid ?? voice?.voiceUuid` — character's own
     field wins) all resolve via `familyKey` (or the `source: 'current'`
     preference where `familyKey` isn't available on a fixture).
   - `voice-library-panel.tsx`'s `VoiceCard` React key, drag state, and
     `isAssigningTarget` highlight key on `familyKey`.
   - `voices.tsx`'s compare/select multi-select (`toggleSelect`,
     `compareDerivations`, `selected=`) and the per-voice variant-count Maps
     (`variantCountByVoiceId`/`missingVariantCountByVoiceId`) key on
     `familyKey`.
   - `voices.ts`'s pin read (`voices.ts:449`) checks
     `pinned.has(dedupKey) || pinned.has(id)` — the second clause is a
     **migration fallback**: a pin set before this change persisted the bare
     id (the only scheme that existed then) in `voices.json`, and nothing
     rewrites that file on upgrade. Without the fallback, a pre-existing pin
     on a voiceId-less character would silently vanish.
   - `profile-drawer.tsx` gets the same `voiceUuid` precedence fix as
     `cast.tsx`, for the narrow case where `stagedVoiceUuid` hasn't yet been
     seeded with the character's own value.

**Deliberately NOT fixed here (deferred — issue
[#1411](https://github.com/dudarenok-maker/Castwright/issues/1411)):** the
cached-audition `sampled` badge still keys on a book-unscoped
`sampleScope` (`c.voiceId ?? char-<id>`) in `voices.ts`. Fixing it requires
coordinating THREE places that must agree on the same scope-naming
convention — `src/lib/sample-scope.ts`'s `sampleScopeFor` (client), the
Qwen design route (write side), and `voices.ts`'s read side — and changing
only the read side would desync it from the write side, breaking the
ALREADY-WORKING same-book badge. Impact is cosmetic only (a misleading
badge); actual sample playback and real chapter generation were never
affected by ANY of this — both always resolve via the `voiceUuid`-keyed
`qwenStorageKey` read straight from the book's own `cast.json`
(`synthesise-chapter.ts`'s `toVoiceLike`), never through the cross-book
aggregator.

## Invariants to preserve

1. `server/src/routes/voices.ts`'s aggregation Map is keyed on `dedupKey`
   (`c.voiceId ?? \`${bookId}::${id}\``), never the bare `id` — a future
   change to this key must preserve "explicit voiceId ⇒ shared identity
   across books; no voiceId ⇒ book-scoped" or the collision reopens.
2. The exposed `Voice.id` field stays `voiceId ?? c.id` (bare, same-book-safe
   only) — do not change it to `familyKey`, or `findVoiceForCharacter`'s /
   `findCharacterForVoice`'s bare-id fallback (rule 2, same-book join) breaks
   for every freshly-analysed character.
3. `findVoiceForCharacter`/`findCharacterForVoice`'s current-book preference
   is opt-in (default `false`). A NEW caller must audit whether its
   character/roster is guaranteed to belong to the globally-open book before
   passing `true` — compare-cast-modal.tsx and rebaseline-modal.tsx are the
   worked counter-examples of callers that must NOT.
4. Any NEW cross-book UI state (React list keys, multi-select sets, drag/
   assign highlight comparisons) that iterates the full workspace-wide
   `library` array must key on `familyKey`, never bare `Voice.id`.

## Test plan

### Automated coverage

- `server/src/routes/voices.test.ts` — "cross-book identity collision on a
  shared, no-voiceId id" describe block: two standalone books sharing a
  bare-id `narrator` character, one rendered (English), one not (Russian) —
  asserts neither book's `generated`/`languageCode`/`voiceUuid`/`usedIn`
  bleeds into the other; `familyKey` values differ; pinning one book's
  entry by `familyKey` never pins the other's; a legacy bare-id pin still
  surfaces (migration fallback).
- `src/lib/voice-character-link.test.ts` — `findVoiceForCharacter`/
  `findCharacterForVoice` both: prefer/restrict-to current-book when opted
  in, fall back to unrestricted bare-id matching by default (the
  compare/rebaseline safety net).
- `src/views/cast.test.tsx` — drag-and-drop resolves this book's own voice
  over a same-id foreign one; the character's own `voiceUuid` wins over a
  stale/foreign matched-voice uuid (and the reverse fallback case, for a
  genuinely reused character).
- `src/store/voices-slice.test.ts` — `setPinned` matches by `familyKey`, not
  bare id.
- `src/views/voices.test.tsx` — selecting two unrelated books' same-bare-id
  voices selects both independently (not a toggle).
- `src/components/voice-library-panel.test.tsx` — `VoiceCard` drag/assign
  highlight keys on `familyKey`, not bare id.
- `src/modals/profile-drawer.test.tsx` — same `voiceUuid` precedence fix,
  exercised via a prop-update rerender (the only reachable path, since
  `stagedVoiceUuid` short-circuits the fallback chain otherwise).

Every fix above was verified fail-before/pass-after by temporarily reverting
it and re-running its paired test.

### Manual acceptance walkthrough

1. Open a freshly-analysed, never-generated book whose narrator/background
   characters have no explicit `voiceId` (any newly-imported non-English
   book satisfies this). Confirm the cast view's Status column does NOT
   show "Generated" or "Sampled" for these rows.
2. Open the voice-library panel's "This book" tab. Confirm the book's own
   narrator/unknown-male/unknown-female voices are NOT hidden behind a
   "can't read \<language\>" toggle.
3. Click "Play 12s" on the narrator/unknown-male/unknown-female rows.
   Confirm the audio is silence/this-book's-own-language, never another
   book's cached sample.
4. On `#/voices`, select two DIFFERENT books' narrator cards for Compare.
   Confirm both stay selected (2/2), and Compare shows each book's own
   voice, not a duplicate of one.

## Out of scope

- The `sampled` badge's own bare-id scope gap — tracked as
  [#1411](https://github.com/dudarenok-maker/Castwright/issues/1411).
- Rekeying the Qwen `.pt` storage convention itself — unrelated;
  `voiceUuid`/`qwenStorageKey` (srv-43, plan 226) already solved that for
  the actual TTS storage layer. This plan is about the AGGREGATION/DISPLAY
  layer above it.

## Ship notes

Shipped 2026-07-07. Two-round PR (`fix/server-voice-identity-collision-clean`,
closes [#1400](https://github.com/dudarenok-maker/Castwright/issues/1400)):
first commit fixed the reported symptom (false Generated/Sampled status,
hidden voice-library entries, wrong sample audio); a high-effort automated
code review then found the fix legitimately allows two unrelated books'
same-slug voices to coexist as separate library entries, which several other
consumers weren't ready for — a second commit closed those gaps
(`familyKey`, the opt-in current-book preference, the pin migration
fallback, the variant-count Maps). A second review round on the follow-up
commit found one more real gap (the unconditional current-book preference
breaking compare-cast-modal.tsx/rebaseline-modal.tsx) plus the pin-migration
gap and the variant-count Maps, all fixed in a third commit. Full frontend
(276 files / 3575 tests) and server (353 files / 4126 tests) suites green,
plus typecheck/build/lint, before merge.
