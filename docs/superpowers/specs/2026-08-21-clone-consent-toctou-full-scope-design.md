---
status: draft
---

# Clone-consent TOCTOU: full-scope design (closes #2006 / srv-81)

Supersedes `2026-08-21-clone-consent-write-time-refusal-design.md` (kept as a
record of a failed fifth attempt — see that file's header). This version is
grounded in #2006's own comment history ("Four mechanisms designed, four
failures"), the design-of-record
(`docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` §7/§12.2/§13),
and a fresh read of every site named across both, not just the three the
original issue body cited.

## Scope, corrected

#2006's own history names more sites than its issue body. Reading every one of
them (not just the three cited) splits them into four severity classes:

### Class A — genuine clone-consent TOCTOU: read/decide and write in different lock scopes, and the write CAN silently mute a consented clone

1. `voices.ts` `PUT /:voiceId/override` — `hasClonedSlotAmongMatches` (unlocked
   workspace/series walk) decides; `applyOverrideToCastFiles` writes per book.
2. `single-design.ts` — `characterHasClonedSlot` decides before the SSE stream
   starts; `applyOverrideToCastFiles` writes from `runSingleDesign`, detached
   after `res.flushHeaders()` and after GPU work.
3. `qwen-voice.ts` — `characterHasClonedSlot` decides before GPU work;
   `persistEmotionVariant` writes after, in both its book-scoped and
   series-propagation branches.
4. `cast-design.ts`'s bulk job — found during this design, not named in the
   original issue. Same shape as (3): `characterHasClonedSlot` re-checked
   fresh each loop iteration, but only *before* that character's GPU work, not
   after (`:369-412` decides, `:544-555` writes).

### Class B — a lock-participation gap, not a validate/write staleness

5. `cast-link-prior.ts` — its clone check (`characterHasClonedSlot` at
   `:206-207`) and its write (`:239-260`) are **already in one lock span**
   (`withCastLocks([source, target], ...)` at `:120`), so there is no
   TOCTOU on the consent decision itself. The real defect: when it plants a
   `libraryUuid` reference onto the source character (`:250-256`,
   gated by `shouldDenormaliseVoice`), it never acquires that uuid's
   `library-voice:<uuid>` key — so a concurrent `DELETE /voice-library/:uuid`
   (which does take that key, per #2000 §7) can erase the artifact this write
   just planted a fresh reference to. This is a missing-lock-participant bug,
   not a stale-decision bug, and needs a different fix shape (below).

### Class C — already correct; no fix needed

6. `voice-override-linked.ts` — `applyToBook` → `applyToBookLocked`
   (`:252-296`) re-checks `characterHasClonedSlot` **inside** its own per-book
   `withCastLock`, on freshly-read data (`:296`). The write-list that decides
   *which* books get called is derived from an earlier, unlocked snapshot —
   but since every individual call still independently re-validates clone
   status against fresh data, list staleness can cause a book to be
   incorrectly included or excluded from the propagation; it cannot cause a
   clone to be silently muted, because the per-book gate that prevents that is
   already race-free. **No change proposed for this site.**

### Class D — mislabeled; doesn't touch clone-bearing fields at all

7. `cast-series-patch.ts` — `applyPatchToCastFile` (`:206-230`) only ever
   writes `gender`/`ageRange`/`tone`. It cannot mute a clone because it never
   touches `overrideTtsVoices`/`ttsEngine`. Its cross-book write-list
   staleness is real but cosmetic (a stale gender/tone patch), not a
   consent issue.
8. `cast-add-from-roster.ts` — copies `voiceId` (a linkage key) from the
   target character, never `overrideTtsVoices` (`:138-153`). Same conclusion:
   no clone-consent risk. Its own comment already documents the residual as
   "out of scope for this task."

Both Class D sites were grouped under #2006 as "cross-book consultations" in
the design-of-record's §12.2, but neither is actually reachable by the
clone-muting failure #2006 exists to prevent. **This design proposes no
change to either** — closing that portion of #2006's scope by finding it was
never actually live, not by deferring it again.

### Class E — a separate bug, same issue, no shared mechanism

9. **Cross-book `voiceUuid` double-mint** — every design gate keys its
   mutual-exclusion on `bookDir` (`withDesignLock`, `isDesignBusy`,
   `cast-design.ts`'s `inFlightByBook`), but `ensureCharacterVoiceUuid`'s
   series-propagation branch (`qwen-voice.ts:230-237`) mints once and stamps
   it across every book in the series in one unlocked walk. Two concurrent
   designs of the same linked character, from two different books in the
   series, can each pass the `!character.voiceUuid` early-out and each mint
   a distinct uuid. This shares #2006's root cause (a decision — "does this
   character already have a uuid" — made outside the scope that acts on it)
   but not its consent-mute failure mode, and not the same fix mechanism as
   classes A/B. Addressed separately, below.

## Why mechanism #1 ("fold into the lock") was rejected before, and why it's viable now

The prior attempt's mechanism #1 was rejected for `voices.ts` specifically
("re-validating under a per-book lock demotes a workspace veto to a per-book
one, and honouring it mid-walk means aborting after k books are already
written") — an **abort-on-conflict** semantic. The prior attempt's strongest
mechanism (#4, a sha256 fingerprint) failed for a *different* reason:
`ensureCharacterVoiceUuid`'s intermediate write (`qwen-voice.ts:235`/`:258`,
verified in this checkout) sets `voiceUuid` and nothing else —
`{ ...c, voiceUuid: uuid }` — so it never touches `overrideTtsVoices` or any
clone-provenance field. A whole-file byte/hash comparison ("did anything
change") trips on this unrelated write; **a predicate re-check ("is this
character's clone status the same, evaluated fresh") does not, structurally,
because the predicate never reads the field the intermediate write touches.**

This design uses a predicate re-check, not a fingerprint CAS, and — for
`voices.ts` — skip-and-continue-and-report rather than abort-on-conflict. Both
changes were named as open, untried options in #2006's own "what the next
attempt needs to answer" list, not among the four that were tried and killed.

## Design

### Class A mechanism

Every write site that persists a voice override or emotion-variant slot gains
a **predicate re-check, re-run at write time, inside the same per-book lock
the write already takes**, reading the just-locked, fresh cast.json. The
existing upfront checks (before GPU work, before any lock) are unchanged and
remain a fast-path.

**Scoped narrowly**, addressing the shared-walker entanglement a fresh read of
the code surfaced: `forEachMatchingCastCharacter`'s `mutate` callback is
`(character: CastCharacter) => CastCharacter` and is shared by
`applyOverrideToCastFiles`, `applyTierToCastFiles` (tier pin only — never
touches voice fields), and `ensureCharacterVoiceUuid`'s own `stamp` (uuid
only). The re-check must not become a blanket property of the walker, or a
tier pin and a uuid mint both start refusing on an unrelated character's
clone status. Add an **optional** `guard?: (character: CastCharacter) =>
{ ok: true } | { ok: false; reason: string }` parameter to
`forEachMatchingCastCharacter`; when present, it runs on the freshly-locked
character immediately before `mutate`, and a `{ ok: false }` skips that
character (recording book + reason) instead of calling `mutate`. Only
`applyOverrideToCastFiles` and `persistEmotionVariant`'s callers pass a guard;
`applyTierToCastFiles` and `ensureCharacterVoiceUuid`'s stamp pass none and
are structurally unaffected.

The guard predicate for the SET branch is `hasClonedProvenance(fresh, engine)`
for any clone-capable engine other than the one being written — generalising
`voices.ts:927`'s existing same-engine preservation logic to also gate the
write. For the CLEAR branch, `single-design.ts`, `qwen-voice.ts`'s base
design, and `cast-design.ts`: `characterHasClonedSlot(fresh)`.

### Refusal semantics, per site

- **`voices.ts` fan-out (workspace/series scope):** skip-and-continue, never
  abort mid-walk. `forEachMatchingCastCharacter` returns which books were
  skipped; `PUT /:voiceId/override` maps the result: all matches skipped → 409
  (unchanged from today's pre-check refusal); some written, some skipped → a
  new partial-success shape; none skipped → unchanged from today. (Today's
  success status is **204**, not 200 — corrected from the superseded draft;
  the partial-success shape needs a body, so it becomes 200 + `skipped`, and
  the pure-success path stays 204 as today, `skipped` omitted. The existing
  404 — no character with that voiceId found anywhere — is a fourth,
  unchanged case: `updatedBookDirs`/`skippedCloneBookDirs` both empty.)
- **`single-design.ts` / `qwen-voice.ts` / `cast-design.ts`, own-book write:**
  the write-time guard fires **after** GPU work, from a context that has
  already committed to a success path. Resolving the "hollow terminal event"
  tension directly rather than by silent reuse: this is **not** the same
  event as the existing pre-GPU-work 409/`character_skipped`. It gets its own
  identifier —
  - `single-design.ts`: a new SSE code, `code: 'clone_protected_race'`,
    documented in `openapi.yaml` as distinct from the existing pre-check
    `clone_protected` 409, with prose stating plainly that it is the rare
    write-time catch, not a duplicate of the upfront check, and that a
    "hollow" hit here means real GPU work was discarded to avoid a worse
    outcome (a muted clone).
  - `qwen-voice.ts`'s own-book (non-series) write: response not yet sent, so
    it refuses with the existing 409 `code: 'clone_protected'` — this one
    genuinely is the same contract as the upfront check, just caught later,
    because the JSON route never flushes early.
  - `qwen-voice.ts`'s series-propagation branch and `cast-design.ts`'s bulk
    job: skip-and-continue-and-report — `cast-design.ts` reuses its own
    existing `character_skipped` / `reason: 'already_cloned'` event verbatim
    (no new event needed, no UI change needed — confirmed against
    `cast-design-stream-middleware.ts`); `qwen-voice.ts`'s response body gains
    a `propagationSkipped: string[]` field for books skipped during
    propagation, parallel to `voices.ts`'s `skipped`.

### Class B mechanism — `cast-link-prior.ts`

The clone check itself needs no change (already race-free). The fix targets
only the missing `library-voice:<uuid>` participation:

1. **Peek** `target.overrideTtsVoices` for candidate library uuids
   *before* taking any lock (a plain unlocked read — this is only to learn
   which key(s) to request; it commits to nothing).
2. **Acquire** `library-voice:<uuid>` for each candidate, then the two cast
   locks (`withCastLocks`), preserving the global `design → library-voice →
   cast` order.
3. **Re-verify inside the lock**: re-read the target fresh; if its current
   library uuid(s) differ from what was peeked, release and retry from step 1
   (bounded retry count, same shape as any optimistic-peek-then-lock pattern;
   the window between peek and lock acquisition is small and this is not a
   hot path). If they match, proceed exactly as today.

This closes the gap without changing the existing `withCastLocks` span's
internal logic at all — it only adds a library-voice acquisition around it,
conditional on what the peek found.

### Class E mechanism — the voiceUuid double-mint

Per the design-of-record's own §12.2 suggestion: wrap
`ensureCharacterVoiceUuid`'s **entire body** (not just its per-book branch) in
a `withKeyLock('series-mint:<author>/<series>')` when `seriesFilter` is
present, serialising concurrent mints for the same linked character across a
series. Acknowledged limitation, stated plainly rather than silently: this
only reaches books already in the propagation match set at request time
(`voices.ts:811`-equivalent skips any book where `!state.castConfirmed`), so a
book that confirms its cast mid-mint is not covered. Not fixed further here —
named as a residual, matching this repo's convention for recording rather
than silently absorbing a known-remaining gap.

## Plumbing changes

- `forEachMatchingCastCharacter`: add the optional `guard` parameter; return
  type becomes `{ updatedBookDirs: string[]; skippedBookDirs: Array<{
  bookDir: string; reason: string }> }` **only when a guard was passed** —
  callers with no guard keep receiving the current `Promise<number>` shape
  (a discriminated overload on whether `guard` is present), so
  `applyTierToCastFiles` and `ensureCharacterVoiceUuid`'s stamp need no
  changes at their call sites.
- `persistEmotionVariant`: corrected from the superseded draft's false
  premise — it currently returns `Promise<void>`, not `Promise<number>`. It
  changes to `Promise<{ updated: boolean; skippedClone: boolean;
  propagationSkipped: string[] }>` so its two callers (the route handler,
  `cast-design.ts`'s variant branch) can each apply their own refusal
  semantic above.
- `openapi.yaml` / `src/lib/api-types.ts`: `PUT /:voiceId/override`'s 204
  response gains a sibling 200 (partial success, `skipped` field);
  `SingleDesignEvent.code` enum gains `clone_protected_race`; `qwen-voice.ts`'s
  design-voice response schema gains `propagationSkipped`. Regenerate via
  `npm run openapi:types` and commit the diff alongside.

## Testing

Every Class A/B site needs a paired test that:

1. Passes the upfront check with no clone present.
2. Injects a clone (or, for the cross-engine SET case, a clone on a different
   engine; for Class B, a concurrent `DELETE /voice-library/:uuid`) **between**
   the upfront check and the write, directly manipulating cast.json inside the
   write-time lock window.
3. Asserts the write-time guard catches it, via the exact refusal channel
   named above for that site — not a silently-applied write.
4. Is mutation-verified: weakening or deleting the guard must turn the test
   red, with the observed failure output captured.

A fan-out test (`voices.ts` workspace scope, `qwen-voice.ts` series
propagation) additionally asserts non-conflicting books still get written — a
skip must not abort siblings. A guard-scoping test asserts `applyTierToCastFiles`
and `ensureCharacterVoiceUuid`'s stamp are unaffected by a cloned character
elsewhere in the same walk (the walker-entanglement regression this design
exists to avoid).

## Out of scope

- Class D sites (`cast-series-patch.ts`, `cast-add-from-roster.ts`) — found to
  carry no clone-consent risk; no change proposed.
- Class C (`voice-override-linked.ts`) — found to already be correct for the
  consent decision; its separate write-list staleness (non-consent) is not
  addressed here.
- Any change to lock granularity or acquisition order beyond Class B's
  `library-voice` participation fix (`#2000` §3.2 stands).
- Caching/replaying GPU output discarded by a `clone_protected_race` refusal.
- The Class E residual named above (a book confirming its cast mid-mint).
