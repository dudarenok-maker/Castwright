---
status: draft
---

# `voices.ts` clone-consent refusal: series-wide veto (part of #2006 / srv-81)

Scope note up front, because the two prior attempts at this issue
(`2026-08-21-clone-consent-write-time-refusal-design.md`,
`2026-08-21-clone-consent-toctou-full-scope-design.md`, both superseded —
see their headers) failed partly by overclaiming scope. **This spec resolves
`voices.ts` `PUT /:voiceId/override` (via `applyOverrideToCastFiles`), its
downstream consumers `single-design.ts`'s single-book call and
`cast-design.ts`'s bulk-job base-voice call, and the two frontend gates that
mirror this same predicate.** It does not touch `qwen-voice.ts`'s emotion-
variant path (see the sibling `2026-08-26-clone-consent-qwen-voice-refusal-
design.md`, which resolves that gate on the same series-wide model this
document now uses), `cast-link-prior.ts`, or the `voiceUuid` double-mint —
those remain open, undesigned, and tracked on #2006 as before.

**Revision note (v2).** v1 chose a "documented partial-success contract":
each book's own write was race-free for its own decision, with no atomicity
across the propagation as a whole. While implementing the sibling
`qwen-voice.ts` spec, that same per-book-independence question was raised
explicitly to the user as a judgment call — clone consent is recorded
per-book (`voice-library.ts`'s clone-assign writes the marker to exactly one
book) while the character's identity and artifact key are series-wide, so a
per-book-independent check can silently write a new assignment for a linked
character elsewhere in the series while correctly refusing the book that
prompted the request. The user decided the same way for this gate:
**clone-consent refusal is scoped to the linked voice identity (series-wide),
not to a single book's marker or a single book's independent decision** — a
clone anywhere in the series refuses the whole propagation, implemented as a
**best-effort** (not fully atomic) fresh scan immediately before the write,
for the same reason the sibling spec gives: full atomicity needs #2000 §3.2's
rejected workspace-lock model reopened, which stays out of scope here too.

This revision also adds the sibling's other two follow-on decisions, made by
the same user at the same time: `cast-design.ts`'s own base-voice call site
(a third caller of `applyOverrideToCastFiles` the v1 draft scoped out) is
brought into the same reporting shape as its emotion-variant sibling, and both
frontend clone gates are upgraded to mirror the series-wide rule rather than
staying book-local.

## The decision this spec finalizes

#2006's own design history established that `voices.ts`'s cross-book veto
(`hasClonedSlotAmongMatches`) cannot be made *fully atomic* with its per-book
write without reopening `#2000` §3.2 (workspace-scoped lock acquisition,
rejected for holding a lock across a full directory walk). That remains true
in v2. What changes is which of the two non-atomic options is chosen:

- **A bounded N-book lock** — after the unlocked scan produces a concrete
  match list, take `withCastLocks` on exactly those N books (sorted), hold it
  for the whole re-check-and-write. Real atomicity, cost bounded by the
  propagation's own size rather than the workspace. Still not chosen — this
  is a strictly bigger change than the one below and was not what the user
  asked for.
- **A best-effort series-wide veto** (chosen, v2) — re-run
  `hasClonedSlotAmongMatches` **fresh, immediately before the write**,
  replacing the stale pre-scan the caller already did. If it finds a clone
  anywhere in the match set, refuse the *entire* propagation: no book is
  written. If it finds none, proceed with the existing per-book walk, which
  keeps its own predicate re-check as a residual-window backstop (below) —
  not because partial success is now the intended contract, but because the
  walk itself still takes nonzero time after the fresh scan passes, and a
  clone landing in that narrower window needs *something* to catch it.

  This is a strictly bigger refusal than v1's per-book contract (an unrelated
  sibling's own write can now be refused because of a clone on a *different*
  book), not a smaller one — the trade the user is making is "protect the
  linked identity more broadly" against "occasionally refuse a book that,
  taken alone, would have been fine to write."

## Mechanism

The fix still lives entirely inside `applyOverrideToCastFiles`
(`server/src/routes/voices.ts:875-953`) and still does **not** change
`forEachMatchingCastCharacter`'s shared signature — v1's reasoning for that
holds unchanged: `applyTierToCastFiles` and `ensureCharacterVoiceUuid`'s own
`stamp`, both also callers of that walker, both unrelated to clone-consent,
must not start participating in a check that has nothing to do with their own
write. `hasClonedSlotAmongMatches` (`voices.ts:615-645`) needs no signature
change either — it already takes exactly the arguments this needs
(`voiceId`, `seriesFilter?`, `otherThanEngine?`), since it is the same
function the upfront check already calls (`voices.ts:712`/`:723`); this
document's fresh call simply re-runs it at write time instead of trusting the
scan the caller already did before this function was invoked.

**Fresh series-wide check, before any write:**

```ts
export async function applyOverrideToCastFiles(
  voiceId: string,
  override: { engine: TtsEngine; name: string } | null,
  seriesFilter?: { author: string; series: string },
  onlyBookDir?: string,
): Promise<{ updated: number; skipped: Array<{ bookDir: string; characterId: string; reason: string }> }> {
  const otherThanEngine = override === null ? undefined : override.engine;
  const stillCloned = await hasClonedSlotAmongMatches(voiceId, seriesFilter, otherThanEngine);
  if (stillCloned) {
    return {
      updated: 0,
      skipped: [{ bookDir: onlyBookDir ?? '(series-wide)', characterId: voiceId, reason: 'already_cloned' }],
    };
  }
  // ... proceed to the walk below, unchanged from v1 except for the count/skip bookkeeping already there
}
```

The synthetic single entry (`bookDir: '(series-wide)'`) is deliberate, not a
placeholder: enumerating every individual matched `(bookDir, characterId)`
pair for a refusal that touched none of them would need a second, purely
read-only walk beyond what `hasClonedSlotAmongMatches` already returns (it
answers `boolean`, not the match list), and no caller of this function
distinguishes *which* book carried the clone from *that* one did — both
`voices.ts`'s response mapping and `single-design.ts`'s single-book collapse
only test `skipped.length > 0`. Building that enumeration purely to populate
an unused level of detail would be speculative machinery this repo's
"simplicity first" convention argues against. `onlyBookDir` is threaded
through when present (the `single-design.ts` caller) so that caller's own
existing "was *my* book in `skipped`" logic still works unchanged — it
already collapses to "is `skipped` non-empty at all" for a single-book match
set, which the synthetic entry still satisfies.

**Predicate re-check, residual-window backstop (unchanged from v1):** the
mutate closure passed to `forEachMatchingCastCharacter` keeps its own
per-book re-check, immune to unrelated intermediate writes exactly as v1
documented — `hasClonedProvenance(fresh, engine)` for other-engine SET,
`characterHasClonedSlot(fresh)` for CLEAR, evaluated against the fresh
per-book read inside that book's own `withCastLock`. On a positive, the
closure returns the character unchanged (harmless idempotent rewrite,
`voices.ts:844-853`'s `dirty = true` fires regardless, exactly as v1 already
noted) and the entry is added to the same `skipped` array — now genuinely
rare (the fresh series-wide check above already caught the routine case),
rather than the primary mechanism v1 relied on.

## Signature change

`applyOverrideToCastFiles` keeps the `Promise<{ updated, skipped }>` shape v1
introduced — no further change to the return type. **Three** call sites now
need updating (v1 listed two; this revision adds the third):

- `voices.ts:731` (`PUT /:voiceId/override`) — maps the result per the
  response table below, unchanged from v1.
- `single-design.ts:179` (`runSingleDesign`, single-book via `onlyBookDir`) —
  unchanged from v1: a non-empty `skipped` for its own book means refuse that
  job.
- **`cast-design.ts:544-549` (new in v2)** — the SSE bulk job's base-voice
  path currently discards the return value entirely (`await
  applyOverrideToCastFiles(...)`, then unconditionally `job.done += 1;
  broadcast(... 'character_designed' ...)`). This is the exact gap the
  sibling `qwen-voice.ts` spec flagged without fixing (v1 of that document
  named it as a question for this spec's author; the user has now answered
  it: mirror the variant branch's existing pattern). Updated to:

  ```ts
  const { updated, skipped } = await applyOverrideToCastFiles(
    matchKey,
    { engine: 'qwen', name: voiceId },
    seriesFilter,
    job.bookDir,
  );
  if (updated === 0 && skipped.length > 0) {
    job.skipped += 1;
    job.clonedSkips.push({ characterId, name: character.name ?? characterId });
    broadcast(job, { type: 'character_skipped', characterId, name: character.name ?? characterId, reason: 'already_cloned' });
  } else {
    job.done += 1;
    broadcast(job, { type: 'character_designed', characterId, voiceId });
  }
  ```

  Same channel the emotion-variant branch already uses two lines below this
  one (`cast-design.ts:555` in the sibling spec) — one bulk job, one
  `clonedSkips` reporting shape for both its base-voice and variant paths,
  not two.

## Response contract for `voices.ts` `PUT /:voiceId/override`

Unchanged from v1 — the four-case table still holds, since the *shape* of
the response didn't change, only *when* `skipped` gets populated (series-wide
scan vs. per-book independent decisions):

| `updated` | `skipped.length` | Status | Body | Change from today |
|---|---|---|---|---|
| >0 | 0 | 204 | none | unchanged |
| >0 | >0 | 200 | `{ updated, skipped }` | **new** — today has no partial-success shape. Now rare: only the residual-window backstop produces this, not the routine case. |
| 0 | >0 | 409 | `{ error, skipped }` | status unchanged (matches today's pre-check 409); body gains `skipped`. Now the routine outcome for "cloned somewhere in the series," not just "cloned in every matched book." |
| 0 | 0 | 404 | `{ error }` | unchanged |

The 0/0 → 404 case is unaffected: it's the existing "no character with this
voiceId found anywhere" branch (`voices.ts:732-739`).

**Noted, not fixed here:** `openapi.yaml` currently documents only
204/400/404 for this route — the 409 exists in code (`voices.ts:713`,
`:724`) but was never added to the spec. Unchanged from v1; still a distinct,
smaller fix to call out in whatever PR implements this.

## Frontend series-awareness (new in v2)

Two frontend gates currently mirror this predicate but read only the
*current book's own* character data, matching v1's per-book model:

- `src/modals/profile-drawer.tsx:1102-1111` — the base-voice "Design" button's
  own client-side gate (`character.overrideTtsVoices?.qwen?.provenance ===
  'cloned' || character.overrideTtsVoices?.coqui?.provenance === 'cloned'`).
- `src/components/emotion-variant-designer.tsx:125-135` — the emotion-variant
  designer's gate (identical shape, gates the whole component rather than one
  button).

Per the user's decision, both should mirror the new series-wide rule rather
than staying book-local. This requires the backend to expose "cloned
somewhere in this character's linked series" as data the frontend can read,
since the frontend only ever has the current book's own cast in hand — a
genuine API surface addition, not a client-only change:

- Add a computed, read-only field to the `Character` shape (`openapi.yaml`'s
  `Character` schema, regenerated into `src/lib/api-types.ts` via `npm run
  openapi:types`) — e.g. `clonedElsewhereInSeries: boolean` — **true** when
  `hasClonedSlotAmongMatches` (this document's own function, reused again)
  finds a clone on some *other* linked book, **false** when the only clone
  (if any) is on this book's own copy (which the existing
  `overrideTtsVoices.*.provenance` fields already expose) or there is none.
  Excluding the caller's own book from this specific field avoids a
  redundant/confusing "double true" when both this book and a sibling are
  independently cloned.
- **Implementation task, not resolved here:** locate the cast-read path that
  serves the confirm/cast views their `Character[]` (the route that turns
  `cast.json` into the API-shaped response the frontend's `characters` slice
  consumes) and compute the field there, once per character, for a
  series-linked book. This document does not cite a specific file:line for
  that site — verify it against the actual working tree at implementation
  time rather than trusting a citation written without reading it, per this
  whole spec's own review history.
- Both frontend gates change from:
  ```ts
  character.overrideTtsVoices?.qwen?.provenance === 'cloned' ||
  character.overrideTtsVoices?.coqui?.provenance === 'cloned'
  ```
  to:
  ```ts
  character.overrideTtsVoices?.qwen?.provenance === 'cloned' ||
  character.overrideTtsVoices?.coqui?.provenance === 'cloned' ||
  character.clonedElsewhereInSeries === true
  ```
- The user-facing copy at both sites (`profile-drawer.tsx:1107-1109`,
  `emotion-variant-designer.tsx:130-133`) currently says "X already has a
  cloned voice" / "X uses a cloned voice" — both false when the clone is on a
  sibling book. Reword to the same book-agnostic phrasing this spec's sibling
  document already gives `clonedVariantRefusal` (`qwen-voice.ts:99`, v2 of
  that spec): the clone is on *this linked character*, not necessarily *this
  book's copy* of them.
- This is additive to, not a replacement for, the backend series-wide checks
  above — the frontend gate is a UX convenience (disable/hide before a round
  trip), the backend checks are what actually enforce consent. A stale or
  unpropagated `clonedElsewhereInSeries` value degrades to "the button is
  offered when it shouldn't be," never to "the write happens when it
  shouldn't" — the backend's own fresh check is authoritative regardless of
  what the frontend believed.

## What this does not claim

- **Not fully atomic**, same reasoning as the sibling spec: the residual
  window between `hasClonedSlotAmongMatches` passing and the walk reaching
  each book is real, though far smaller than v1's original per-book-only
  window. A true atomic veto needs #2000 §3.2's workspace-lock reopened — out
  of scope here.
- A client cannot tell, from the 200/`skipped` shape alone, whether a
  residual-window skip is "a clone appeared during this exact request" vs.
  some other cause — same limitation v1 already named, now covering a
  narrower (rarer) case.
- Does not address `qwen-voice.ts`'s own mechanism in detail (see that
  sibling spec directly), `cast-link-prior.ts`, or the `voiceUuid`
  double-mint.
- Does not change `#2000` §3.2's lock-granularity decision.
- Does not implement the frontend field's exact backend wiring — named as an
  implementation task above, not designed to the file:line level here.

## Testing

Paired tests for `applyOverrideToCastFiles`:

1. Two (or more) matching books, no clone anywhere in the match set — request
   succeeds, `updated === 2`, `skipped === []`, 204.
2. Clone present on a book **not** in the caller's own request path (e.g. a
   sibling book, for a request whose `bookId`/`onlyBookDir` context is a
   different book) at call time — the *entire* propagation refuses:
   `updated === 0`, `skipped` contains the synthetic series-wide entry, 409.
   This is the corrected version of v1's test 2, which asserted "book A
   applied, book B skipped" as the expected 200 partial-success outcome — v2
   makes that the *wrong* expectation; a clone anywhere refuses everywhere.
3. **Residual-window case (new in v2):** clone injected into a specific book
   *after* the fresh `hasClonedSlotAmongMatches` call has already returned
   `false`, but *before* the walk reaches that specific book (the narrower
   race v1's mechanism is now reserved for) — that book lands in `skipped`
   with `reason: 'already_cloned'` from the per-book closure backstop, other
   matched books still get `updated`, response is 200 with a non-empty
   `skipped` — the one remaining path that produces this "genuine" partial
   shape.
4. All matching books cloned at write time — `updated === 0`, `skipped`
   non-empty (either via the fresh series-wide check short-circuiting, or,
   in the unlikely case every book's own clone appeared only in the residual
   window, via the per-book backstop populating one entry per book), 409.
5. No matching book at all — unchanged 404, `skipped` never appears (this
   path doesn't reach the new code).
6. Mutation-verified: deleting the fresh series-wide check must turn test 2
   red; deleting the per-book closure backstop must turn test 3 red — two
   separate mutations, two separate assertions, since v2 has two distinct
   layers where v1 had one.
7. A guard-scoping regression test: a concurrent `applyTierToCastFiles` or
   `ensureCharacterVoiceUuid` call against a book with a cloned character in
   this same walk is unaffected — unchanged from v1, still proving the fix's
   closure-scoping, not the shared walker, is what changed.
8. `cast-design.ts:544`'s new branch: mock `applyOverrideToCastFiles` to
   return `{updated: 0, skipped: [...]}`  — assert `job.skipped` incremented,
   `job.clonedSkips` gains the entry, and the broadcast matches the existing
   `character_skipped`/`already_cloned` shape the variant branch already
   uses two lines below it.
9. Frontend: with `clonedElsewhereInSeries: true` and no book-local clone
   provenance, both gated components render their refusal state (button
   disabled / variant designer replaced by its hint), matching the existing
   book-local-clone test coverage's shape but keyed on the new field instead.
