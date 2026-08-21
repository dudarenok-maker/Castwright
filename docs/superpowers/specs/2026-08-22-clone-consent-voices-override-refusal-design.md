---
status: draft
---

# `voices.ts` clone-consent refusal: documented partial-success (part of #2006 / srv-81)

Scope note up front, because the two prior attempts at this issue
(`2026-08-21-clone-consent-write-time-refusal-design.md`,
`2026-08-21-clone-consent-toctou-full-scope-design.md`, both superseded —
see their headers) failed partly by overclaiming scope. **This spec resolves
one site only: `voices.ts` `PUT /:voiceId/override` (via
`applyOverrideToCastFiles`), and its one downstream consumer,
`single-design.ts`'s single-book call.** It does not touch, and makes no
claim about, `qwen-voice.ts`'s series-propagation branch, `cast-design.ts`'s
bulk job, `cast-link-prior.ts`, or the `voiceUuid` double-mint — those remain
open, undesigned, and tracked on #2006 as before. Do not read "closes #2006"
into this document; it closes one gate of several.

## The decision this spec finalizes

#2006's own design history (see the two superseded specs for the full
citation trail) established that `voices.ts`'s cross-book veto
(`hasClonedSlotAmongMatches`) cannot be made atomic with its per-book write
without reopening `#2000` §3.2 (workspace-scoped lock acquisition, rejected
for holding a lock across a full directory walk). Two options were on the
table:

- **A bounded N-book lock** — after the unlocked scan produces a concrete
  match list, take `withCastLocks` on exactly those N books (sorted), hold it
  for the whole re-check-and-write. Real atomicity, cost bounded by the
  propagation's own size rather than the workspace. Not chosen — deferred as
  more work than this pass needs.
- **A documented partial-success contract** (chosen) — no atomicity across
  books. Each book's own write is race-free for its own decision; the
  operation as a whole is not one atomic yes/no. This trades a weaker
  guarantee for materially less implementation risk, and is stated at exactly
  that strength below — not as "closing the window."

## Mechanism

The fix lives entirely inside `applyOverrideToCastFiles`
(`server/src/routes/voices.ts:875-953`) and does **not** change
`forEachMatchingCastCharacter`'s shared signature. This is deliberate: round
2 of adversarial review found a prior draft's `guard` parameter on the shared
walker would have made `applyTierToCastFiles` and `ensureCharacterVoiceUuid`'s
own `stamp` — both also callers of that walker, both unrelated to
clone-consent — start participating in a check that has nothing to do with
their own write. Scoping the fix to `applyOverrideToCastFiles`'s own mutate
closure makes that entanglement structurally impossible rather than merely
avoided by care.

**Predicate re-check, immune to unrelated intermediate writes.** The mutate
closure already runs per-book, inside that book's `withCastLock`, on a
freshly-read character (`forEachMatchingCastCharacter`'s existing behaviour,
`voices.ts:809-861`). It gains: before applying the override, re-evaluate the
same clone predicate the upfront `hasClonedSlotAmongMatches` check used —
`hasClonedProvenance(fresh, engine)` for other-engine SET,
`characterHasClonedSlot(fresh)` for CLEAR — against this fresh read, not the
pre-scan snapshot. Confirmed immune to `ensureCharacterVoiceUuid`'s
intermediate write (`qwen-voice.ts:235`/`:258`, both `{ ...c, voiceUuid: uuid
}` only) in round 2 of review: the predicate reads `overrideTtsVoices`, which
that write never touches.

**On a positive re-check:** the closure returns the character **unchanged**
(no field mutation) rather than applying the override. This is a harmless
idempotent rewrite from `forEachMatchingCastCharacter`'s point of view — the
walker still writes the book's cast.json (it cannot tell mutate declined),
but the bytes are identical to what was already on disk, so there is no data
consequence, only a wasted disk write in the rare skip case. The skip itself
is recorded in a side-channel `skipped: Array<{ bookDir: string; characterId:
string; reason: string }>` array that `applyOverrideToCastFiles` owns and
closes over — not derived from the walker's own return value, which is not
trustworthy for this purpose (it counts a no-op "skip" write the same as a
real one). `applyOverrideToCastFiles` tracks its own `updated` count
independently, incrementing only when the predicate passes.

## Signature change

`applyOverrideToCastFiles` changes from `Promise<number>` to:

```ts
Promise<{ updated: number; skipped: Array<{ bookDir: string; characterId: string; reason: string }> }>
```

Two call sites, both updated in this change:

- `voices.ts:731` (`PUT /:voiceId/override`) — maps the result per the table
  below.
- `single-design.ts:179` (`runSingleDesign`, single-book via `onlyBookDir`) —
  a non-empty `skipped` for its own book means refuse that job. This is not a
  new design question: it is single-book by construction
  (`onlyBookDir` is passed, so at most one book's worth of entries can appear
  in `skipped`), so it collapses to the same refusal the existing pre-GPU-work
  check already performs, just reachable at write time too. **How that
  refusal reaches the SSE stream is not decided by this spec** — round 2 found
  the previous draft invented an OpenAPI enum field (`SingleDesignEvent.code`)
  that does not exist in the schema, and this document does not repeat that
  mistake. `single-design.ts`'s own refusal channel is out of scope here and
  remains open, same as the other undesigned sites listed above.

## Response contract for `voices.ts` `PUT /:voiceId/override`

All four cases distinguished explicitly (a prior draft's mapping silently
collapsed two of them):

| `updated` | `skipped.length` | Status | Body | Change from today |
|---|---|---|---|---|
| >0 | 0 | 204 | none | unchanged |
| >0 | >0 | 200 | `{ updated, skipped }` | **new** — today has no partial-success shape |
| 0 | >0 | 409 | `{ error, skipped }` | status unchanged (matches today's pre-check 409); body gains `skipped` |
| 0 | 0 | 404 | `{ error }` | unchanged |

The 0/0 → 404 case is unaffected by this change: it's the existing
"no character with this voiceId found anywhere" branch (`voices.ts:732-739`),
computed the same way it is today (`updated === 0`, now also requiring
`skipped.length === 0` to distinguish it from the new all-skipped 409 case).

**Noted, not fixed here:** `openapi.yaml` currently documents only
204/400/404 for this route — the 409 exists in code (`voices.ts:713`,
`:724`) but was never added to the spec. Touching this response block is a
natural place to close that gap too, but it is a distinct, smaller fix from
the partial-success shape this document adds, and should be called out as
such in whatever PR implements this (not silently folded in as if it were
part of the new behaviour).

## What this does not claim

- No atomicity across books touched by one request. A client cannot tell,
  from the 200/`skipped` shape alone, whether the skip is "harmless, the
  clone was always there" or "a clone appeared during this exact request" —
  both look identical. If that distinction ever matters to a caller, it is
  not available here.
- Does not address `qwen-voice.ts`, `cast-design.ts`, `cast-link-prior.ts`, or
  the `voiceUuid` double-mint. Each remains exactly as open as the
  design-of-record and #2006's comment history already recorded it.
- Does not change `#2000` §3.2's lock-granularity decision.

## Testing

Paired test for `applyOverrideToCastFiles`:

1. Two (or more) matching books, no clone on either — request succeeds,
   `updated === 2`, `skipped === []`, 204.
2. Inject a clone into book B **between** the upfront scan and book B's own
   write (direct cast.json manipulation inside the write-time lock window,
   not before the request starts) — book A still gets `updated`, book B
   lands in `skipped` with a stated reason, response is 200.
3. All matching books cloned at write time — `updated === 0`,
   `skipped.length > 0`, 409.
4. No matching book at all — unchanged 404, `skipped` never appears (this
   path doesn't reach the new code).
5. Mutation-verified: deleting the write-time predicate re-check must turn
   test 2 red (the clone gets silently overwritten instead of skipped), with
   the observed failure output captured.
6. A guard-scoping regression test: a concurrent `applyTierToCastFiles` or
   `ensureCharacterVoiceUuid` call against a book with a cloned character in
   this same walk is unaffected — proving the fix's closure-scoping, not the
   shared walker, is what changed.
